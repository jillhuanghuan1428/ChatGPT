import { initialPuzzle, applyPuzzleAction, migratePuzzle } from './puzzle.mjs';
import { recordTeamRanking } from './leaderboard.mjs';
const ROOM_PATH = '/api/rooms';
const ROOM_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 4096;
const MAX_PLAYERS = 8;
const MAX_WRITE_ATTEMPTS = 10;
const encoder = new TextEncoder();

class RoomError extends Error {
  constructor(status, key, headers) {
    super(key);
    this.status = status;
    this.headers = headers;
  }
}

function fail(status, key, headers) {
  throw new RoomError(status, key, headers);
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

async function readObject(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) fail(413, 'body_too_large');
  if (!request.body) fail(400, 'invalid_json');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        fail(413, 'body_too_large');
      }
      body += decoder.decode(value, { stream: true });
    }
    const parsed = JSON.parse(body + decoder.decode());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'invalid_json');
    return parsed;
  } catch (error) {
    if (error instanceof RoomError) throw error;
    fail(400, 'invalid_json');
  } finally {
    reader.releaseLock();
  }
}

function playerName(body) {
  if (typeof body.name !== 'string') fail(400, 'invalid_name');
  const name = body.name.normalize('NFC').trim();
  if (!name || [...name].length > 24 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) fail(400, 'invalid_name');
  return name;
}

function toHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, byte => ROOM_ALPHABET[byte & 31]).join('');
}

async function hashToken(token) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));
}

async function newPlayer(name) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const player = { id: crypto.randomUUID(), name, tokenHash: await hashToken(token) };
  return { player, token };
}

function unauthorized() {
  fail(401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' });
}

async function readTokenHash(request) {
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(request.headers.get('authorization') || '');
  if (!match) unauthorized();
  return hashToken(match[1]);
}

function authenticatedPlayer(state, tokenHash) {
  const player = state.players.find(candidate => candidate.tokenHash === tokenHash);
  if (!player) unauthorized();
  return player;
}

function publicRoom(code, state, revision, expiresAt) {
  const ranking = state.ranking;
  const stageTime = ranking.times[state.puzzle.levelIndex];
  return {
    code,
    round: state.round,
    revision,
    expiresAt,
    players: state.players.map(({ id, name }) => ({ id, name, isHost: id === state.hostId })),
    puzzle: state.puzzle,
    solved: state.puzzle.solved,
    ranking: { name: ranking.name, cleared: ranking.times.filter(time => time !== null).length, elapsedMs: ranking.times.reduce((sum, time) => sum + (time ?? 0), 0), stageStartedAt: state.puzzle.mode === 'campaign' ? ranking.stageStartedAt : null, stageElapsedMs: state.puzzle.mode !== 'campaign' ? 0 : stageTime ?? (ranking.stageStartedAt === null ? 0 : Math.max(0, Date.now() - ranking.stageStartedAt)), stageTimes: [...ranking.times] }
  };
}

function newRanking(name) {
  return { id: crypto.randomUUID(), name: [...name].slice(0, 21).join('') + '的小队', times: [null, null, null, null, null], starts: [null, null, null, null, null], stageStartedAt: null };
}
async function syncTeamRanking(db, state) {
  const ranking = state.ranking;
  const cleared = ranking.times.filter(time => time !== null).length;
  if (!cleared) return;
  try { await recordTeamRanking({ DB: db }, { id: ranking.id, name: ranking.name, cleared, elapsedMs: ranking.times.reduce((sum, time) => sum + (time ?? 0), 0) }); }
  catch { /* Ranking writes are retried by later polls without interrupting a game. */ }
}

function newRound(round) {
  return { round, puzzle: initialPuzzle() };
}

async function loadRoom(db, code) {
  const row = await db.prepare('SELECT state, version, expires_at FROM rooms WHERE code = ?').bind(code).first();
  if (!row) fail(404, 'room_not_found');
  if (row.expires_at <= Date.now()) fail(410, 'room_expired');
  const { round, players, hostId, puzzle, ranking } = JSON.parse(row.state);
  const state = { round, players, hostId, puzzle: puzzle ? migratePuzzle(puzzle) : initialPuzzle(), ranking: ranking ?? newRanking(players.find(p => p.id === hostId)?.name || 'Moon') };
  if (!Array.isArray(state.ranking.starts)) {
    state.ranking.starts = [null, null, null, null, null];
    if (state.puzzle.mode === 'campaign') state.ranking.starts[state.puzzle.levelIndex] = state.ranking.stageStartedAt ?? null;
  }
  state.ranking.stageStartedAt = state.puzzle.mode === 'campaign' ? state.ranking.starts[state.puzzle.levelIndex] : null;
  return { state, version: row.version, expiresAt: row.expires_at };
}

async function createRoom(db, name) {
  const { player, token } = await newPlayer(name);
  const state = { ...newRound(1), players: [player], hostId: player.id, ranking: newRanking(name) };
  const stateJSON = JSON.stringify(state);

  // Bound housekeeping work per request. Expiry checks also work when no room is created.
  await db.prepare(`DELETE FROM rooms WHERE code IN (
    SELECT code FROM rooms WHERE expires_at <= ? ORDER BY expires_at LIMIT 16
  )`).bind(Date.now()).run();

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const code = newRoomCode();
    const expiresAt = Date.now() + ROOM_TTL_MS;
    const insert = await db.prepare(`INSERT INTO rooms (code, state, version, expires_at)
      VALUES (?, ?, 1, ?) ON CONFLICT(code) DO NOTHING`).bind(code, stateJSON, expiresAt).run();
    if (insert.meta.changes === 1) {
      return { room: publicRoom(code, state, 1, expiresAt), token, playerId: player.id };
    }
  }
  fail(503, 'service_unavailable');
}

async function mutateRoom(db, code, change) {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const { state, version, expiresAt } = await loadRoom(db, code);
    const { playerId, changed = true } = change(state, version);
    if (!changed) { await syncTeamRanking(db, state); return { room: publicRoom(code, state, version, expiresAt), playerId }; }
    const now = Date.now();
    const nextExpiry = state.players.length ? now + ROOM_TTL_MS : now;
    const nextVersion = version + 1;
    const update = await db.prepare(`UPDATE rooms SET state = ?, version = ?, expires_at = ?
      WHERE code = ? AND version = ? AND expires_at > ?`)
      .bind(JSON.stringify(state), nextVersion, nextExpiry, code, version, now).run();
    if (update.meta.changes === 1) {
      await syncTeamRanking(db, state);
      return { room: publicRoom(code, state, nextVersion, nextExpiry), playerId };
    }
    // A competing request won the write. Re-read and re-check the action against that version.
  }
  fail(409, 'conflict');
}

async function joinRoom(db, code, name) {
  const { player, token } = await newPlayer(name);
  const joined = await mutateRoom(db, code, state => {
    if (state.players.length >= MAX_PLAYERS) fail(409, 'room_full');
    state.players.push(player);
    return { playerId: player.id };
  });
  return { ...joined, token };
}

function validateAction(body) {
  if (!Number.isSafeInteger(body.round) || body.round < 1) fail(400, 'invalid_action');
  if (body.type === 'leave' || body.type === 'reset') return;
  if (body.type !== 'puzzle' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 ||
      !body.action || typeof body.action !== 'object' || Array.isArray(body.action)) {
    fail(400, 'invalid_action');
  }
}

function applyAction(state, playerId, body, revision) {
  if (state.round !== body.round) fail(409, 'stale_round');
  if (body.type === 'leave') {
    state.players = state.players.filter(player => player.id !== playerId);
    if (state.hostId === playerId) state.hostId = state.players[0]?.id ?? null;
    return true;
  }
  if (body.type === 'reset') {
    if (playerId !== state.hostId) fail(403, 'forbidden');
    state.round += 1;
    state.puzzle = applyPuzzleAction(state.puzzle, { type: 'restart' });
    return true;
  }
  if (body.expectedRevision !== revision) fail(409, 'stale_revision');
  const stageAction = ['restart', 'next', 'startLevel', 'newChallenge'].includes(body.action.type);
  if (stageAction && playerId !== state.hostId) fail(403, 'forbidden');
  const action = body.action.type === 'newChallenge' && body.action.seed === undefined
    ? { ...body.action, seed: crypto.getRandomValues(new Uint32Array(1))[0] }
    : body.action;
  let updated;
  try {
    updated = applyPuzzleAction(state.puzzle, action);
  } catch (error) {
    const known = ['slot_empty', 'socket_empty', 'slot_full', 'invalid_action', 'invalid_puzzle', 'puzzle_solved', 'level_locked', 'level_unsolved', 'campaign_complete', 'challenge_complete', 'wrong_epoch'];
    if (!known.includes(error.code)) throw error;
    fail(error.code === 'invalid_action' ? 400 : 422, error.code);
  }
  const changed = JSON.stringify(updated) !== JSON.stringify(state.puzzle);
  const index = state.puzzle.levelIndex;
  const ranking = state.ranking;
  const unfinished = state.puzzle.mode === 'campaign' && ranking.times[index] === null && !(state.puzzle.completed & (1 << index));
  let rankingChanged = false;
  if (!stageAction && unfinished && ranking.starts[index] === null) { ranking.starts[index] = Date.now(); ranking.stageStartedAt = ranking.starts[index]; rankingChanged = true; }
  if (unfinished && !state.puzzle.solved && updated.solved) { ranking.times[index] = Math.max(1, Date.now() - ranking.starts[index]); rankingChanged = true; }
  const nextStartedAt = updated.mode === 'campaign' ? ranking.starts[updated.levelIndex] : null;
  if (nextStartedAt !== ranking.stageStartedAt) { ranking.stageStartedAt = nextStartedAt; rankingChanged = true; }
  state.puzzle = updated;
  if (stageAction) state.round += 1;
  return changed || stageAction || rankingChanged;
}

export async function handleRooms(request, env) {
  const path = new URL(request.url).pathname.replace(/\/$/, '');
  if (path !== ROOM_PATH && !path.startsWith(`${ROOM_PATH}/`)) return null;

  try {
    if (path === ROOM_PATH) {
      if (request.method !== 'POST') fail(405, 'method_not_allowed', { Allow: 'POST' });
      return json(await createRoom(env.DB, playerName(await readObject(request))), 201);
    }

    const match = /^\/api\/rooms\/([^/]+)(?:\/(join|action))?$/.exec(path);
    if (!match) fail(404, 'not_found');
    const code = match[1].toUpperCase();
    if (code.length !== 8 || !Array.from(code).every(letter => ROOM_ALPHABET.includes(letter))) fail(400, 'invalid_room_code');
    const operation = match[2];
    const method = operation ? 'POST' : 'GET';
    if (request.method !== method) fail(405, 'method_not_allowed', { Allow: method });

    if (operation === 'join') {
      return json(await joinRoom(env.DB, code, playerName(await readObject(request))));
    }
    const tokenHash = await readTokenHash(request);
    if (operation === 'action') {
      const body = await readObject(request);
      validateAction(body);
      return json(await mutateRoom(env.DB, code, (state, revision) => {
        const playerId = authenticatedPlayer(state, tokenHash).id;
        return { playerId, changed: applyAction(state, playerId, body, revision) };
      }));
    }
    const { state, version, expiresAt } = await loadRoom(env.DB, code);
    const playerId = authenticatedPlayer(state, tokenHash).id;
    await syncTeamRanking(env.DB, state);
    return json({ room: publicRoom(code, state, version, expiresAt), playerId });
  } catch (error) {
    if (error instanceof RoomError) return json({ error: error.message }, error.status, error.headers);
    return json({ error: 'service_unavailable' }, 503);
  }
}
