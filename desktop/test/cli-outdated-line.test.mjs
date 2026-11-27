// ATO-2523: when the agent says the Claude Code / Codex CLI is outdated
// (`event: cli_outdated`, once per session), the chat shows one line
// before the reply, with the update command drawn as code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { cliOutdatedLine, cliOutdatedHTML, cliOutdatedDraw, cliOutdatedCommands } = createRequire(import.meta.url)('../renderer/cli-outdated-line.js');
const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const CLAUDE = {
  object: 'atomic.cli_outdated', session_id: 's1', step_index: 0, cli: 'claude', version: '2.1.0', minimum: '2.1.22',
  update_commands: ['claude update'],
  notice: 'Claude Code 2.1.0 is out of date: run `claude update` (Atomic Agent needs 2.1.22 or newer).',
};

test('the frame draws one line before the reply, the command as code', () => {
  const user = { id: 1, k: 'user', text: 'hi' };
  const item = { id: 2, k: 'assistant', text: '' };
  const log = [user, item];
  let n = 10;
  assert.equal(cliOutdatedDraw(CLAUDE, log, item, () => ++n, esc), true);
  assert.equal(log.length, 3);
  assert.deepEqual(log[1], {
    id: 11, k: 'system', note: true,
    text: 'Claude Code 2.1.0 is out of date: run <code class="mono">claude update</code> (Atomic Agent needs 2.1.22 or newer).',
  });
  assert.equal(log[2], item);
});

test('without a notice it is worded from the fields; Windows gets only what the agent sent', () => {
  const win = { cli: 'codex', version: '0.121.0', minimum: '0.122.0', update_commands: ['npm install -g @openai/codex@latest'] };
  assert.equal(cliOutdatedLine(win), 'Codex 0.121.0 is out of date: run `npm install -g @openai/codex@latest` (Atomic Agent needs 0.122.0 or newer).');
  assert.doesNotMatch(cliOutdatedLine(win), /brew/);
  assert.equal(cliOutdatedLine({ cli: 'claude' }), 'Claude Code is out of date.');
  assert.equal(cliOutdatedLine({ cli: 'other' }), '');
  assert.equal(cliOutdatedLine(null), '');
  assert.deepEqual(cliOutdatedCommands({ update_commands: ['a', '', 7, 'b\nc', 'd', 'e', 'f'] }), ['a', 'd', 'e']);
  for (const l of [cliOutdatedLine(win), CLAUDE.notice]) assert.doesNotMatch(l, /\u2014/);
});

test('markup in the agent text is escaped, in and out of code', () => {
  assert.equal(cliOutdatedHTML('<b>x</b> run `<i>y</i>`', esc), '&lt;b>x&lt;/b> run <code class="mono">&lt;i>y&lt;/i></code>');
});

test('without the reply row on screen nothing is drawn', () => {
  const log = [];
  assert.equal(cliOutdatedDraw(CLAUDE, log, undefined, () => 1, esc), false);
  assert.equal(cliOutdatedDraw(CLAUDE, log, { id: 9 }, () => 1, esc), false);
  assert.equal(log.length, 0);
});

test('the page loads the helper before renderer.js and the chat event router hands the frame to it', () => {
  const at = html.indexOf('src="cli-outdated-line.js"');
  assert.ok(at > 0 && at < html.indexOf('src="renderer.js"'));
  assert.match(renderer, /const LIVE_DRAWS = new Set\(\[[^\]]*'cli_outdated'/, 'kept for a chat the person left mid-turn');
  assert.match(renderer, /if \(ev\.kind === 'cli_outdated'\) \{ if \(typeof cliOutdatedDraw === 'function' && cliOutdatedDraw\(ev\.payload, S\.log, item, nid, esc\)\) render\(\); return; \}/);
});
