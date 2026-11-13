const COLORS = ['blue', 'amber', 'violet'];
const SOURCES = { moon: 'blue', sun: 'amber', star: 'violet' };
const SOCKETS = ['below', 'above', 'left', 'right'];
const POSITIONS = { below: { x: 0, y: 1 }, above: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const DIRECTIONS = [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 0, dy: -1 }];
const REASONS = ['no_light', 'wrong_color', 'wrong_direction', 'wrong_socket', 'missing_signal', 'wrong_epoch', 'too_early', 'too_late', 'closed_exit', 'caught'];
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function integer(v, min, max) { return Number.isInteger(v) && v >= min && v <= max; }
function isBeam(b) { return isObject(b) && COLORS.includes(b.color) && Number.isInteger(b.dx) && Number.isInteger(b.dy) && Math.abs(b.dx) + Math.abs(b.dy) === 1 && (b.epoch === undefined || ['before', 'after'].includes(b.epoch)); }
function copyBeam(b) { return b === null ? null : { color: b.color, dx: b.dx, dy: b.dy, epoch: b.epoch || 'before' }; }

function campaignConfig(index, route) {
  const common = { independent: false, requiresEpoch: false, routeChoice: false, routeDurations: null, exitOpenAt: null, sourceDirections: Object.fromEntries(Object.keys(SOURCES).map(s => [s, { dx: 1, dy: 0 }])) };
  const levels = [
    { title: ['Borrowed Moonlight', '借来的月亮'], rule: ['Catch blue moonlight and reach the lower switch at 15.', '借来蓝色月光，让它在第15拍抵达下方道岔。'], targets: [{ socket: 'below', color: 'blue', arrival: 15, delay: 3 }], pulseOptions: [10, 12, 15] },
    { title: ['Twin Signals', '双星会面'], rule: ['Two different lights must arrive together.', '用同一个发射时刻，让两种光同时抵达。'], targets: [{ socket: 'below', color: 'blue', arrival: 15, delay: 3 }, { socket: 'left', color: 'amber', arrival: 15, delay: 3 }], pulseOptions: [10, 12, 15] },
    { title: ['Before the Eclipse', '月蚀之前'], rule: ['Borrow starlight before the eclipse, then carry it into the future.', '回到月蚀前借星光，再携光跳到月蚀后安装。'], targets: [{ socket: 'above', color: 'violet', arrival: 16, delay: 3 }], pulseOptions: [10, 12, 13, 15, 16], requiresEpoch: true },
    { title: ['Echo Relay', '回声长廊'], rule: ['Set each socket clock separately to meet two shuttles.', '独立设置两座灯台的时钟，分别接住两班穿梭艇。'], targets: [{ socket: 'above', color: 'blue', arrival: 15, delay: 4 }, { socket: 'right', color: 'amber', arrival: 18, delay: 2 }], pulseOptions: [10, 11, 12, 15, 16], independent: true },
    { title: ['Starport Concerto', '星港合奏'], rule: ['The short route arrives before the exit opens. Plan the detour and both lights.', '出口第20拍才打开。选择绕行路线，再安排两束光。'], targets: [{ socket: 'below', color: 'blue', arrival: 15, delay: 3 }, { socket: 'left', color: 'violet', arrival: route === 'long' ? 20 : 18, delay: 5 }], pulseOptions: [10, 12, 13, 15, 16], independent: true, routeChoice: true, routeDurations: { short: 3, long: 5 }, exitOpenAt: 20 }
  ];
  return { ...common, ...levels[index] };
}
function randomGenerator(seed) {
  let x = seed >>> 0;
  return max => { x = (x + 0x6D2B79F5) >>> 0; let t = Math.imul(x ^ x >>> 15, 1 | x); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) % max; };
}
function challengeConfig(seed, route) {
  const random = randomGenerator(seed);
  const family = [1, 3, 4][seed % 3];
  const ports = [...SOCKETS];
  for (let i = ports.length - 1; i > 0; i--) { const j = random(i + 1); [ports[i], ports[j]] = [ports[j], ports[i]]; }
  const firstArrival = 14 + random(3);
  const firstDelay = 2 + random(3);
  const independent = family !== 1;
  const secondDelay = independent ? 1 + random(4) : firstDelay;
  const routeDurations = family === 4 ? { short: 2 + random(2), long: 5 + random(2) } : null;
  const secondArrival = routeDurations ? firstArrival + routeDurations[route] : independent ? firstArrival + 2 + random(3) : firstArrival;
  const targets = [{ socket: ports[0], color: COLORS[random(3)], arrival: firstArrival, delay: firstDelay }, { socket: ports[1], color: COLORS[random(3)], arrival: secondArrival, delay: secondDelay }];
  const required = [firstArrival - firstDelay, secondArrival - secondDelay];
  if (routeDurations) required.push(firstArrival + routeDurations.short - secondDelay, firstArrival + routeDurations.long - secondDelay);
  const pulseOptions = [...new Set([...required, Math.min(...required) - 1, Math.max(...required) + 1])].sort((a, b) => a - b);
  const sourceDirections = Object.fromEntries(Object.keys(SOURCES).map(source => [source, { ...DIRECTIONS[random(4)] }]));
  return { title: ['Starport Variation', '星港变奏'], rule: ['A new star chart, clocks and optical paths share one reproducible seed.', '每个星图编号都会重组灯位、光源方向与时钟。'], targets, pulseOptions, independent, requiresEpoch: false, routeChoice: family === 4, routeDurations, exitOpenAt: routeDurations ? firstArrival + routeDurations.long : null, sourceDirections, family };
}
function configFor(puzzle) {
  const c = puzzle.mode === 'challenge' ? challengeConfig(puzzle.seed, puzzle.route) : campaignConfig(puzzle.levelIndex, puzzle.route);
  return { ...c, timelineStart: Math.min(...c.pulseOptions), timelineEnd: Math.max(...c.targets.map(t => t.arrival), ...c.pulseOptions.map(t => t + 5)) + 1 };
}
export function getPuzzleConfig(puzzle) {
  if (!isObject(puzzle) || !['campaign', 'challenge'].includes(puzzle.mode) || !integer(puzzle.levelIndex, 0, 4) || !integer(puzzle.seed, 0, 0xffffffff) || !['short', 'long'].includes(puzzle.route)) fail('invalid_puzzle');
  return configFor(puzzle);
}
function validatePuzzle(puzzle) {
  const config = getPuzzleConfig(puzzle);
  if (puzzle.version !== 2 || !integer(puzzle.unlocked, 0, 4) || !integer(puzzle.completed, 0, 31) || !integer(puzzle.mirror, 0, 3) || !['before', 'after'].includes(puzzle.epoch) || typeof puzzle.solved !== 'boolean' || !isObject(puzzle.sockets) || !isObject(puzzle.pulses) || !config.pulseOptions.includes(puzzle.pulse)) fail('invalid_puzzle');
  if (puzzle.beam !== null && !isBeam(puzzle.beam)) fail('invalid_puzzle');
  for (const socket of SOCKETS) if ((puzzle.sockets[socket] !== null && !isBeam(puzzle.sockets[socket])) || !config.pulseOptions.includes(puzzle.pulses[socket])) fail('invalid_puzzle');
  if (puzzle.attempt !== null && (!isObject(puzzle.attempt) || !REASONS.includes(puzzle.attempt.reason) || !Array.isArray(puzzle.attempt.paths) || !Array.isArray(puzzle.attempt.trace))) fail('invalid_puzzle');
}
function emptyStage(options) {
  const puzzle = { version: 2, mode: options.mode, levelIndex: options.levelIndex, unlocked: options.unlocked, completed: options.completed, seed: options.seed, epoch: 'before', pulses: {}, route: 'short', beam: null, mirror: 1, sockets: { below: null, above: null, left: null, right: null }, pulse: 10, attempt: null, solved: false };
  const config = configFor(puzzle);
  puzzle.epoch = config.requiresEpoch ? 'after' : 'before';
  puzzle.pulse = config.pulseOptions[0];
  puzzle.pulses = Object.fromEntries(SOCKETS.map(s => [s, puzzle.pulse]));
  return puzzle;
}
export function initialPuzzle(options = {}) {
  if (!isObject(options)) fail('invalid_puzzle');
  const metadata = { mode: options.mode ?? 'campaign', levelIndex: options.levelIndex ?? 0, unlocked: options.unlocked ?? 0, completed: options.completed ?? 0, seed: options.seed ?? 0 };
  if (!['campaign', 'challenge'].includes(metadata.mode) || !integer(metadata.levelIndex, 0, 4) || !integer(metadata.unlocked, 0, 4) || !integer(metadata.completed, 0, 31) || !integer(metadata.seed, 0, 0xffffffff)) fail('invalid_puzzle');
  return emptyStage(metadata);
}
export function migratePuzzle(value) {
  if (!isObject(value)) fail('invalid_puzzle');
  if (value.version === 2) { const copy = structuredClone(value); copy.completed ??= 0; validatePuzzle(copy); return copy; }
  if (value.version !== 1 || !integer(value.mirror, 0, 3) || ![10, 12, 15].includes(value.pulse) || typeof value.solved !== 'boolean' || !isObject(value.sockets) || (value.beam !== null && !isBeam(value.beam))) fail('invalid_puzzle');
  for (const socket of SOCKETS) if (value.sockets[socket] !== null && !isBeam(value.sockets[socket])) fail('invalid_puzzle');
  const copy = initialPuzzle({ unlocked: value.solved ? 1 : 0, completed: value.solved ? 1 : 0 });
  Object.assign(copy, { mirror: value.mirror, pulse: value.pulse, beam: copyBeam(value.beam), solved: value.solved, attempt: value.attempt === null ? null : structuredClone(value.attempt), sockets: Object.fromEntries(SOCKETS.map(s => [s, copyBeam(value.sockets[s])])), pulses: Object.fromEntries(SOCKETS.map(s => [s, value.pulse])) });
  validatePuzzle(copy);
  return copy;
}

function validateAction(action, config) {
  if (!isObject(action)) fail('invalid_action');
  switch (action.type) {
    case 'capture': if (!Object.hasOwn(SOURCES, action.source)) fail('invalid_action'); return;
    case 'place': case 'remove': if (!SOCKETS.includes(action.socket)) fail('invalid_action'); return;
    case 'setPulse': if (!config.pulseOptions.includes(action.time) || (config.independent && !SOCKETS.includes(action.socket))) fail('invalid_action'); return;
    case 'setEpoch': if (!config.requiresEpoch || !['before', 'after'].includes(action.epoch)) fail('invalid_action'); return;
    case 'setRoute': if (!config.routeChoice || !['short', 'long'].includes(action.route)) fail('invalid_action'); return;
    case 'startLevel': if (!integer(action.index, 0, 4)) fail('invalid_action'); return;
    case 'newChallenge': if (action.seed !== undefined && !integer(action.seed, 0, 0xffffffff)) fail('invalid_action'); return;
    case 'rotate': case 'reflect': case 'run': case 'restart': case 'next': return;
    default: fail('invalid_action');
  }
}
// Screen coordinates: east=(1,0), north=(0,-1); mirrors /, backslash, -, |.
function reflected(beam, mirror) {
  const { dx, dy } = beam;
  const [nextX, nextY] = [[-dy, -dx], [dy, dx], [dx, -dy], [-dx, dy]][mirror];
  return { ...beam, dx: nextX || 0, dy: nextY || 0 };
}
function beamPath(socket, beam) {
  const start = { ...POSITIONS[socket] };
  const reachesSwitch = start.x + beam.dx === 0 && start.y + beam.dy === 0;
  const end = reachesSwitch ? { x: 0, y: 0 } : beam.dx !== 0 ? { x: beam.dx * 2, y: start.y } : { x: start.x, y: beam.dy * 2 };
  return { socket, beam: copyBeam(beam), points: [start, end], reachesSwitch };
}
function evaluateTarget(puzzle, config, target) {
  const beam = puzzle.sockets[target.socket];
  const emitters = Object.entries(puzzle.sockets).filter(([, b]) => b !== null);
  const pulse = config.independent ? puzzle.pulses[target.socket] : puzzle.pulse;
  const signalAt = pulse + target.delay;
  const wanted = { dx: -POSITIONS[target.socket].x, dy: -POSITIONS[target.socket].y };
  let reason = 'caught';
  if (config.requiresEpoch && puzzle.epoch !== 'after') reason = 'wrong_epoch';
  else if (!emitters.length) reason = 'no_light';
  else if (beam === null) {
    if (!emitters.some(([, b]) => b.color === target.color)) reason = 'wrong_color';
    else if (!emitters.some(([, b]) => b.color === target.color && b.dx === wanted.dx && b.dy === wanted.dy)) reason = 'wrong_direction';
    else reason = 'wrong_socket';
  } else if (beam.color !== target.color) reason = 'wrong_color';
  else if (beam.dx !== wanted.dx || beam.dy !== wanted.dy) reason = 'wrong_direction';
  else if (config.requiresEpoch && beam.epoch !== 'before') reason = 'wrong_epoch';
  else if (signalAt < target.arrival) reason = 'too_early';
  else if (signalAt > target.arrival) reason = 'too_late';
  return { ...target, pulse, signalAt, matched: reason === 'caught', reason };
}
function runPuzzle(puzzle, config) {
  const targetResults = config.targets.map(target => evaluateTarget(puzzle, config, target));
  let reason = targetResults.find(result => !result.matched)?.reason || 'caught';
  const finalArrival = Math.max(...config.targets.map(target => target.arrival));
  if (reason === 'caught' && config.exitOpenAt !== null && finalArrival < config.exitOpenAt) reason = 'closed_exit';
  const redirected = reason === 'caught';
  const signalKeys = { wrong_color: 'light_filtered', wrong_direction: 'light_turned_away', wrong_socket: 'light_missed_switch', missing_signal: 'light_missed_switch', wrong_epoch: 'wrong_epoch', too_early: 'pulse_passed_early', too_late: 'pulse_arrived_late', caught: 'switch_lit' };
  const trace = [];
  for (const result of targetResults) {
    trace.push({ at: result.pulse, kind: 'pulse', socket: result.socket, textKey: result.reason === 'no_light' ? 'no_emission' : 'pulse_sent' });
    if (result.reason !== 'no_light') trace.push({ at: result.signalAt, kind: 'signal', socket: result.socket, textKey: signalKeys[result.reason] || 'light_missed_switch' });
    trace.push({ at: result.arrival, kind: 'shuttle', socket: result.socket, textKey: result.matched ? 'shuttle_redirected' : 'shuttle_passed' });
  }
  if (reason === 'closed_exit') trace.push({ at: finalArrival, kind: 'exit', textKey: 'closed_exit' });
  puzzle.attempt = { reason, targetResults, paths: SOCKETS.filter(socket => puzzle.sockets[socket] !== null).map(socket => beamPath(socket, puzzle.sockets[socket])), route: { points: [{ x: -2, y: 0 }, { x: 0, y: 0 }, { x: 2, y: redirected ? -1 : 0 }], switchAt: config.targets[0].arrival, redirected, arrivals: config.targets.map(t => t.arrival), exitOpenAt: config.exitOpenAt }, trace: trace.sort((a, b) => a.at - b.at) };
  puzzle.solved = redirected;
  if (redirected && puzzle.mode === 'campaign') { puzzle.completed |= 1 << puzzle.levelIndex; puzzle.unlocked = Math.max(puzzle.unlocked, Math.min(4, puzzle.levelIndex + 1)); }
}
export function applyPuzzleAction(value, action) {
  const next = migratePuzzle(value);
  const config = configFor(next);
  validateAction(action, config);
  if (action.type === 'restart') return emptyStage(next);
  if (action.type === 'startLevel') { if (action.index > next.unlocked) fail('level_locked'); return emptyStage({ ...next, mode: 'campaign', levelIndex: action.index }); }
  if (action.type === 'newChallenge') return emptyStage({ ...next, mode: 'challenge', seed: action.seed ?? ((next.seed + 0x9e3779b9) >>> 0) });
  if (action.type === 'next') {
    if (next.mode !== 'campaign') fail('challenge_complete');
    if (!next.solved) fail('level_unsolved');
    if (next.levelIndex === 4) fail('campaign_complete');
    return emptyStage({ ...next, levelIndex: next.levelIndex + 1 });
  }
  if (next.solved) { if (action.type === 'run') return next; fail('puzzle_solved'); }
  switch (action.type) {
    case 'capture':
      if (config.requiresEpoch && next.epoch !== 'before') fail('wrong_epoch');
      next.beam = { color: SOURCES[action.source], ...config.sourceDirections[action.source], epoch: next.epoch };
      break;
    case 'rotate': next.mirror = (next.mirror + 1) % 4; break;
    case 'reflect': if (next.beam === null) fail('slot_empty'); next.beam = reflected(next.beam, next.mirror); break;
    case 'place':
      if (next.beam === null) fail('slot_empty');
      if (config.requiresEpoch && next.epoch !== 'after') fail('wrong_epoch');
      next.sockets[action.socket] = next.beam; next.beam = null; break;
    case 'remove':
      if (next.sockets[action.socket] === null) fail('socket_empty');
      if (next.beam !== null) fail('slot_full');
      next.beam = next.sockets[action.socket]; next.sockets[action.socket] = null; break;
    case 'setPulse':
      if (config.independent) next.pulses[action.socket] = action.time;
      else { next.pulse = action.time; for (const socket of SOCKETS) next.pulses[socket] = action.time; }
      break;
    case 'setEpoch': next.epoch = action.epoch; break;
    case 'setRoute': next.route = action.route; break;
    case 'run': runPuzzle(next, config); return next;
  }
  next.attempt = null;
  return next;
}
