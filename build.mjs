import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';

const project = new URL('./', import.meta.url);
const read = path => readFileSync(new URL(path, project), 'utf8').replace(/^\uFEFF/, '');
const template = read('worker/game.html');
if (!template.includes('__PUZZLE__') || !template.includes('__ART__')) {
  throw new Error('The game template is missing its puzzle or artwork marker.');
}
const puzzleSource = read('worker/puzzle.mjs').replace(/^export\s+(?=(?:function|class|const|let)\s)/gm, '');
const puzzleFactory = `(() => {\n${puzzleSource}\nreturn { initialPuzzle, applyPuzzleAction, getPuzzleConfig, migratePuzzle };\n})()`;
const scenes = ['scene-observatory.webp', 'scene-bridge.webp', 'scene-dock.webp'];
const artwork = scenes.map(name => 'data:image/webp;base64,' + readFileSync(new URL('worker/' + name, project)).toString('base64'));
const html = template
  .replace('__PUZZLE__', () => 'window.LightPuzzle = ' + puzzleFactory + ';')
  .replace('__ART__', () => JSON.stringify(artwork));
const roomModule = read('worker/rooms.mjs')
  .replace(/import\s*\{[^}]+\}\s*from\s*['"]\.\/(?:puzzle|leaderboard)\.mjs['"];?/g, '');
const leaderboardModule = read('worker/leaderboard.mjs')
  .replace(/import\s*\{[^}]+\}\s*from\s*['"]\.\/puzzle\.mjs['"];?/g, '')
  .replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let)\s)/gm, '');
const appModule = read('worker/app.mjs').replace('__GAME_HTML__', () => JSON.stringify(html));
mkdirSync(new URL('dist/server/', project), { recursive: true });
mkdirSync(new URL('dist/.openai/', project), { recursive: true });
const server = 'const { initialPuzzle, applyPuzzleAction, getPuzzleConfig, migratePuzzle } = ' + puzzleFactory + ';\n' + leaderboardModule + '\n' + roomModule + '\n' + appModule;
writeFileSync(new URL('dist/server/index.js', project), server, 'utf8');
copyFileSync(new URL('.openai/hosting.json', project), new URL('dist/.openai/hosting.json', project));
cpSync(new URL('drizzle/', project), new URL('dist/.openai/drizzle/', project), { recursive: true });
console.log('Built dist/server/index.js');
if (process.argv.includes('--offline')) {
  const offline = new URL('../../outputs/Borrowed-Moon-Echoes-of-a-Spy.html', project);
  writeFileSync(offline, html, 'utf8');
  console.log('Saved the standalone offline game.');
}
