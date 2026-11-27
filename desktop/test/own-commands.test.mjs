// ATO-2441: your own slash commands in the desktop / menu (renderer/own-commands.js) and their wiring.
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {ownCommandSlashRows, ownCommandResolve, ownCommandsHiddenHint, createOwnCommands} = require('../renderer/own-commands.js');

const BUILTINS = [['help', 'Show commands', ''], ['clear', 'Clear the chat', '', ['cls']]];

test('lists own and plugin commands, leaving built-in and skill names alone', () => {
  const rows = ownCommandSlashRows([
    {name: 'review', command: 'review', description: 'Review the diff', source: 'profile', argumentHint: '<branch>'},
    {name: 'team:deploy', command: 'team:deploy', description: 'Deploy', source: 'project'},
    {name: 'help', command: 'help', description: 'Mine', source: 'profile'},
    {name: 'cls', command: 'cls', description: 'Mine too', source: 'claude'},
    {name: 'lint', command: 'lint', description: 'A skill has it', source: 'profile'},
    {name: 'Bad Name', command: 'x', description: '', source: 'profile'},
    {name: 'old', command: 'old', description: 'From Claude Code', source: 'claude'},
  ], BUILTINS, ['lint']);
  assert.deepEqual(rows, [
    ['review', 'Review the diff', '<branch>', []],
    ['team:deploy', 'Deploy', 'project', []],
    ['old', 'From Claude Code', '~/.claude', []],
  ]);
});

test('a plugin command gets its short name only when nothing else has it', () => {
  const rows = ownCommandSlashRows([
    {name: 'review', command: 'review', description: 'Mine', source: 'profile'},
    {name: 'tools:review', command: 'review', description: 'Plugin review', source: 'plugin'},
    {name: 'tools:fmt', command: 'fmt', description: 'Format', source: 'plugin'},
    {name: 'a:sync', command: 'sync', description: 'A', source: 'plugin'},
    {name: 'b:sync', command: 'sync', description: 'B', source: 'plugin'},
    {name: 'x:help', command: 'help', description: 'Taken', source: 'plugin'},
  ], BUILTINS, []);
  const alias = Object.fromEntries(rows.map(r => [r[0], r[3]]));
  assert.deepEqual(alias['tools:review'], []);
  assert.deepEqual(alias['tools:fmt'], ['fmt']);
  assert.deepEqual(alias['a:sync'], []);
  assert.deepEqual(alias['b:sync'], []);
  assert.deepEqual(alias['x:help'], []);
  assert.equal(ownCommandResolve(rows, 'fmt'), 'tools:fmt');
  assert.equal(ownCommandResolve(rows, 'REVIEW'), 'review');
  assert.equal(ownCommandResolve(rows, 'help'), null);
  assert.equal(ownCommandResolve(rows, ''), null);
});

test('says how many command files wait for trust', () => {
  assert.equal(ownCommandsHiddenHint(0), '');
  assert.equal(ownCommandsHiddenHint(1), '1 command file in this folder waits until you trust the folder.');
  assert.equal(ownCommandsHiddenHint(3), '3 command files in this folder wait until you trust the folder.');
});

test('offers only the rows read for this chat, and nothing from an agent without the route', async () => {
  const reads = [
    {supported: true, ok: true, data: {commands: [{name: 'review', command: 'review', description: 'R', source: 'profile'}], hiddenProjectCommands: 2}},
    {supported: true, ok: false, error: 'down'},
    {supported: false},
  ];
  const seen = [];
  const own = createOwnCommands({read: async id => { seen.push(id); return reads.shift(); }, render: async () => ({ok: false})});
  await own.refresh('chat-a', 's1');
  assert.deepEqual(own.slashRows('chat-a', BUILTINS, []).map(r => r[0]), ['review']);
  assert.deepEqual(own.slashRows('chat-b', BUILTINS, []), []);
  assert.match(own.hint('chat-a'), /^2 command files/);
  await own.refresh('chat-a', 's1');   // a failed read keeps this folder's rows
  assert.deepEqual(own.slashRows('chat-a', BUILTINS, []).map(r => r[0]), ['review']);
  await own.refresh('chat-a', null);
  assert.deepEqual(own.slashRows('chat-a', BUILTINS, []), []);
  assert.deepEqual(seen, ['s1', 's1', null]);
});

test('renders through the agent and reports a refused shell line without text to send', async () => {
  const bodies = [];
  const answers = [
    {ok: true, data: {text: 'Review main:\n+line', source: 'profile'}},
    {ok: false, code: 'command_refused', error: '`git push` was not allowed'},
  ];
  const own = createOwnCommands({read: async () => ({supported: false}), render: async body => { bodies.push(body); return answers.shift(); }});
  assert.deepEqual(await own.run('review', 'main', 's1'), {ok: true, text: 'Review main:\n+line'});
  assert.deepEqual(await own.run('push', '', null), {ok: false, refused: true, why: '`git push` was not allowed'});
  assert.deepEqual(bodies, [{name: 'review', args: 'main', sessionId: 's1'}, {name: 'push'}]);
  assert.equal(own.state.running, null);
});

test('one command at a time', async () => {
  let finish;
  const own = createOwnCommands({read: async () => ({supported: false}),
    render: () => new Promise(resolve => { finish = resolve; })});
  const first = own.run('review', '', null);
  assert.deepEqual(await own.run('other', '', null), {ok: false, why: '/review is still running'});
  finish({ok: true, data: {text: 'done', source: 'profile'}});
  assert.deepEqual(await first, {ok: true, text: 'done'});
});

test('the menu, submit, main and preload are wired to the agent routes', () => {
  const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../preload/preload.ts', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../main/agent-client.ts', import.meta.url), 'utf8');
  assert.ok(html.indexOf('<script src="own-commands.js"></script>') > 0);
  assert.ok(html.indexOf('own-commands.js') < html.indexOf('<script src="renderer.js"></script>'));
  assert.match(renderer, /SLASH\.concat\([^\n]*ownSlashRows\(\)\)/);
  assert.match(renderer, /ownCommandResolve\(ownSlashRows\(\), [^\n]*\{ submitOwnCommand\(text\); return; \}/);
  assert.match(renderer, /if \(!wasSlash\) refreshOwnCommands\(\);/);
  // A rendered command that starts with `/` is a message, not a built-in run by accident.
  assert.match(renderer, /if \(text\.startsWith\('\/'\) && typeof preparedSkillText !== 'string'\) \{ runSlash/);
  assert.match(preload, /commandList: \(sessionId\?: string \| null\) => ipcRenderer\.invoke\("agent:commandList", sessionId\)/);
  assert.match(preload, /commandRender: \(body[^\n]*ipcRenderer\.invoke\("agent:commandRender", body\)/);
  assert.match(main, /ipcMain\.handle\("agent:commandList"/);
  assert.match(main, /ipcMain\.handle\("agent:commandRender"/);
  assert.match(client, /\/api\/commands\$\{sessionId/);
  assert.match(client, /\/api\/commands\/render`/);
});
