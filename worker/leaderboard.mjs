import { initialPuzzle, applyPuzzleAction } from './puzzle.mjs';

const LB_TTL_MS = 24 * 60 * 60 * 1000;
const LB_BODY_LIMIT = 4096;
const LB_ACTIONS = new Set(['capture', 'place', 'remove', 'rotate', 'reflect', 'setPulse', 'setEpoch', 'setRoute', 'run', 'restart', 'next']);
const lbEncoder = new TextEncoder();

class LeaderboardError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
function lbFail(status, code) { throw new LeaderboardError(status, code); }
function lbJson(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
async function lbReadBody(request) {
  if (Number(request.headers.get('content-length')) > LB_BODY_LIMIT) lbFail(413, 'body_too_large');
  if (!request.body) lbFail(400, 'invalid_json');
  const reader = request.body.getReader();
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > LB_BODY_LIMIT) { await reader.cancel().catch(() => {}); lbFail(413, 'body_too_large'); }
      text += decoder.decode(value, { stream: true });
    }
    const body = JSON.parse(text + decoder.decode());
    if (!body || typeof body !== 'object' || Array.isArray(body)) lbFail(400, 'invalid_json');
    return body;
  } catch (error) {
    if (error instanceof LeaderboardError) throw error;
    lbFail(400, 'invalid_json');
  } finally { reader.releaseLock(); }
}
function lbName(value) {
  if (typeof value !== 'string') lbFail(400, 'invalid_name');
  const name = value.normalize('NFC').trim();
  if (!name || [...name].length > 24 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) lbFail(400, 'invalid_name');
  return name;
}
function lbHex(bytes) { return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''); }
async function lbHash(token) { return lbHex(new Uint8Array(await crypto.subtle.digest('SHA-256', lbEncoder.encode(token)))); }
async function lbRequestHash(request) {
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(request.headers.get('authorization') || '');
  if (!match) lbFail(401, 'unauthorized');
  return lbHash(match[1].toLowerCase());
}
function lbCleared(state) { return state.times.filter(value => value !== null).length; }
function lbElapsed(state) { return state.times.reduce((sum, value) => sum + (value || 0), 0); }
function lbPublicRun(row, state, now = Date.now()) {
  const startedAt = state.stageStartedAt;
  return {
    id: row.id, name: row.name, kind: 'solo', puzzle: state.puzzle, revision: row.revision,
    cleared: lbCleared(state), elapsedMs: lbElapsed(state),
    stageElapsedMs: state.times[state.puzzle.levelIndex] ?? (startedAt === null ? 0 : Math.max(0, now - startedAt)),
    stageStartedAt: startedAt, stageTimes: state.times, expiresAt: row.expires_at,
  };
}
async function lbSaveScore(env, { id, name, kind, cleared, elapsedMs, now }) {
  await env.DB.prepare(`INSERT INTO leaderboard_scores (id, name, kind, cleared, elapsed_ms, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, cleared=excluded.cleared,
    elapsed_ms=excluded.elapsed_ms, updated_at=excluded.updated_at
    WHERE excluded.cleared > leaderboard_scores.cleared OR
    (excluded.cleared = leaderboard_scores.cleared AND excluded.elapsed_ms < leaderboard_scores.elapsed_ms)`)
    .bind(id, name, kind, cleared, elapsedMs, now).run();
}

// Called only with server-computed room progress, never values from a public request.
export async function recordTeamRanking(env, { id, name, cleared, elapsedMs }) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,120}$/.test(id)) throw new Error('invalid_team_id');
  if (!Number.isInteger(cleared) || cleared < 1 || cleared > 5 || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) throw new Error('invalid_team_score');
  await lbSaveScore(env, { id: 'team:' + id, name: lbName(name), kind: 'team', cleared, elapsedMs, now: Date.now() });
}

async function lbList(request, env) {
  const kind = new URL(request.url).searchParams.get('kind') || 'solo';
  if (!['solo', 'team'].includes(kind)) lbFail(400, 'invalid_kind');
  const result = await env.DB.prepare(`SELECT name, kind, cleared, elapsed_ms, updated_at FROM leaderboard_scores
    WHERE kind = ? AND cleared > 0 ORDER BY cleared DESC, elapsed_ms ASC, updated_at ASC, id ASC LIMIT 50`).bind(kind).all();
  return lbJson({ kind, entries: result.results.map(row => ({ name: row.name, kind: row.kind, cleared: row.cleared, elapsedMs: row.elapsed_ms, updatedAt: row.updated_at })) });
}
async function lbCreate(request, env) {
  const body = await lbReadBody(request);
  const name = lbName(body.name);
  const now = Date.now();
  const id = crypto.randomUUID();
  const token = lbHex(crypto.getRandomValues(new Uint8Array(32)));
  const state = { puzzle: initialPuzzle(), times: [null, null, null, null, null], stageStartedAt: null };
  const row = { id, name, revision: 1, expires_at: now + LB_TTL_MS };
  await env.DB.prepare('DELETE FROM leaderboard_runs WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare(`INSERT INTO leaderboard_runs (id, token_hash, name, state, revision, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, await lbHash(token), name, JSON.stringify(state), 1, now, row.expires_at).run();
  return lbJson({ run: lbPublicRun(row, state, now), token }, 201);
}
async function lbRun(request, env, id) {
  const tokenHash = await lbRequestHash(request);
  const row = await env.DB.prepare('SELECT id, token_hash, name, state, revision, expires_at FROM leaderboard_runs WHERE id = ?').bind(id).first();
  if (!row || row.token_hash !== tokenHash) lbFail(401, 'unauthorized');
  const now = Date.now();
  if (row.expires_at <= now) lbFail(410, 'run_expired');
  const state = JSON.parse(row.state);
  if (request.method === 'GET') return lbJson({ run: lbPublicRun(row, state, now) });
  const body = await lbReadBody(request);
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1 || !body.action || !LB_ACTIONS.has(body.action.type)) lbFail(400, 'invalid_action');
  if (body.expectedRevision !== row.revision) lbFail(409, 'stale_revision');
  let puzzle;
  try { puzzle = applyPuzzleAction(state.puzzle, body.action); }
  catch (error) {
    const code = error.code || error.message;
    if (['invalid_action', 'invalid_puzzle'].includes(code)) lbFail(400, 'invalid_action');
    if (['slot_empty', 'slot_full', 'socket_empty', 'puzzle_solved', 'level_locked', 'level_unsolved', 'campaign_complete', 'challenge_complete', 'wrong_epoch', 'already_solved'].includes(code)) lbFail(422, code);
    throw error;
  }
  const index = state.puzzle.levelIndex;
  // Only a successfully applied action starts the timer. Reads and validation failures do not.
  if (!['restart', 'next'].includes(body.action.type) && state.times[index] === null && state.stageStartedAt === null) state.stageStartedAt = now;
  const newlySolved = !state.puzzle.solved && puzzle.solved && state.times[index] === null;
  if (newlySolved) state.times[index] = Math.max(1, now - state.stageStartedAt);
  if (puzzle.levelIndex !== index) state.stageStartedAt = null;
  state.puzzle = puzzle;
  const result = await env.DB.prepare('UPDATE leaderboard_runs SET state = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND expires_at > ?')
    .bind(JSON.stringify(state), id, row.revision, now).run();
  if (!result.meta.changes) lbFail(409, 'stale_revision');
  row.revision += 1;
  if (newlySolved) await lbSaveScore(env, { id: 'solo:' + id, name: row.name, kind: 'solo', cleared: lbCleared(state), elapsedMs: lbElapsed(state), now });
  return lbJson({ run: lbPublicRun(row, state, now) });
}

export async function handleLeaderboard(request, env) {
  const path = new URL(request.url).pathname;
  if (path !== '/api/leaderboard' && !path.startsWith('/api/leaderboard/')) return null;
  try {
    if (!env.DB) lbFail(503, 'service_unavailable');
    if (path === '/api/leaderboard') {
      if (request.method !== 'GET') lbFail(405, 'method_not_allowed');
      return await lbList(request, env);
    }
    if (path === '/api/leaderboard/runs') {
      if (request.method !== 'POST') lbFail(405, 'method_not_allowed');
      return await lbCreate(request, env);
    }
    const match = /^\/api\/leaderboard\/runs\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(path);
    if (!match) lbFail(404, 'not_found');
    if (!['GET', 'POST'].includes(request.method)) lbFail(405, 'method_not_allowed');
    return await lbRun(request, env, match[1].toLowerCase());
  } catch (error) {
    if (error instanceof LeaderboardError) return lbJson({ error: error.message }, error.status);
    console.error('Leaderboard request failed:', error);
    return lbJson({ error: 'service_unavailable' }, 503);
  }
}
