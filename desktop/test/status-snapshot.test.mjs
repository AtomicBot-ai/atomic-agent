import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {statusElapsed, statusTurnRows, statusSnapshotOf, statusSnapshotLines, statusSnapshotHTML} =
  createRequire(import.meta.url)('../renderer/status-snapshot.js');

// ATO-965: /status prints a snapshot of the turn running in the chat on screen.

let n = 0;
const row = (k, extra) => Object.assign({id: 'r' + (++n), k}, extra);
const user = (extra) => row('user', Object.assign({text: 'q'}, extra));
const tool = (extra) => row('tool', Object.assign({name: 'os.fs.read', ok: true, open: false, out: 'raw /Users/x/secret'}, extra));
const MIN = 60_000;

test('the card from the issue: plan, now, last result, blocked, time, calls', () => {
  const log = [user(), tool(), tool({name: 'os.shell.run'})];
  const snap = statusSnapshotOf(log, {running: true, startedAt: 1, now: 1 + 134 * MIN, pending: null,
    plan: {done: 5, total: 8, current: 'integration tests'}});
  assert.deepEqual(statusSnapshotLines(snap), [
    'Plan: 5/8 · Now: integration tests',
    'Last result: os.shell.run · ok',
    'Blocked: no · 2h 14m · 2 tool calls',
  ]);
});

test('only the turn in flight counts; a steer does not start a new one', () => {
  const log = [user(), tool(), tool(), row('assistant', {text: 'done'}), user(), tool(), user({steered: true}), tool({ok: null, name: 'os.shell.run'})];
  assert.equal(statusTurnRows(log).length, 3);
  const snap = statusSnapshotOf(log, {running: true, startedAt: 1, now: 41_001});
  assert.deepEqual(statusSnapshotLines(snap), [
    'Now: Running os.shell.run',
    'Last result: os.fs.read · ok',
    'Blocked: no · 40s · 2 tool calls',
  ]);
});

test('an approval waiting is what blocks the turn', () => {
  const log = [user(), tool({ok: false, outcome: 'denied', name: 'os.fs.write'})];
  const snap = statusSnapshotOf(log, {running: true, startedAt: 1, now: 2, pending: {tool: 'os.shell.run'}});
  const lines = statusSnapshotLines(snap);
  assert.equal(lines[0], 'Now: waiting for your approval of os.shell.run');
  assert.equal(lines[1], 'Last result: os.fs.write · denied');
  assert.match(lines[2], /^Blocked: yes, on your approval of os\.shell\.run · /);
});

test('says so when nothing runs, and never echoes a tool output', () => {
  assert.deepEqual(statusSnapshotLines(statusSnapshotOf([user(), tool()], {running: false})), ['No turn is running.']);
  const html = statusSnapshotHTML(statusSnapshotOf([user(), tool({ok: false})], {running: true, startedAt: 0, now: 0}), (s) => s);
  assert.doesNotMatch(html, /secret/);
  assert.match(html, /os\.fs\.read · failed/);
});

test('escapes each line for the system row', () => {
  const html = statusSnapshotHTML(statusSnapshotOf([user(), tool({name: '<b>x</b>'})], {running: true, startedAt: 0, now: 0}),
    (s) => String(s).replace(/</g, '&lt;'));
  assert.ok(!html.includes('<b>'));
  assert.equal(html.split('<br>').length, 3);
});

test('elapsed scales from seconds to hours', () => {
  assert.equal(statusElapsed(0), '0s');
  assert.equal(statusElapsed(5 * MIN + 3000), '5m 03s');
  assert.equal(statusElapsed(134 * MIN), '2h 14m');
});

test('the page loads status-snapshot.js before renderer.js, and /status uses it', async () => {
  const {readFileSync} = await import('node:fs');
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = html.indexOf('src="status-snapshot.js"');
  assert.ok(at > 0 && at < html.indexOf('src="renderer.js"'));
  const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(renderer, /\['status','what the running turn is doing/);
  assert.match(renderer, /if \(name === 'status'\) \{/);
  assert.match(renderer, /statusSnapshotHTML\(snap, esc\)/);
});
