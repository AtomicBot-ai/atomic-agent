// ATO-1184: the mode chip works while a turn runs (renderer/mode-mid-turn.js + setCodingMode wiring).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const M = require('../renderer/mode-mid-turn.js');

const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const fnBody = (name) => {
  const at = renderer.indexOf('\nasync function ' + name + '(') >= 0
    ? renderer.indexOf('\nasync function ' + name + '(') : renderer.indexOf('\nfunction ' + name + '(');
  assert.ok(at >= 0, name + ' is a top-level function in renderer.js');
  const end = renderer.indexOf('\n}\n', at);
  return renderer.slice(at, end + 2);
};

test('idle: the line is the mode summary, unchanged', () => {
  assert.equal(M.modeChangeNote('Auto: file edits run without asking', {midTurn: false}), 'Auto: file edits run without asking');
  assert.equal(M.modeChangeNote('Auto', null), 'Auto');
});

test('mid-turn: the line says it counts from the next action', () => {
  const s = M.modeChangeNote('Auto', {midTurn: true, cardWaiting: false});
  assert.match(s, /^Auto \(from the agent's next action in this turn\)$/);
});

test('mid-turn under a waiting request: the card still needs an answer (the gate does not resolve it)', () => {
  const s = M.modeChangeNote('Bypass', {midTurn: true, cardWaiting: true});
  assert.match(s, /next action in this turn/);
  assert.match(s, /request already waiting still needs your answer/);
});

test('setCodingMode no longer refuses while a turn runs', () => {
  const body = fnBody('setCodingMode');
  assert.doesNotMatch(body, /if \(S\.busy\) \{ toast\('Not while a turn is running'\); return; \}/);
  assert.doesNotMatch(body, /Not while a turn is running/);
  // The change line goes inside the running turn, not under its reply.
  assert.match(body, /\(S\.busy \|\| approvalOpen\(S\.pending\)\) \? placeInLiveTurn\(entry\) : S\.log\.push\(entry\)/);
  assert.match(body, /modeChangeNote\(summary, \{midTurn, cardWaiting: approvalOpen\(S\.pending\)\}\)/);
  // The click still outranks a reconnect's queued re-assert.
  assert.match(body, /cancelModeReassert\(\);/);
});

test('the switch lane does not hold the mode for a turn (it restarts nothing)', () => {
  const body = fnBody('swxExecute');
  assert.match(body, /const held = want && want\.route === false \? null : restartStopsTurn\(\);/);
  assert.doesNotMatch(body, /route === false \? \(S\.busy/);
});

test('the reconnect re-assert still waits for the turn (unchanged path)', () => {
  const body = fnBody('reassertCodingMode');
  assert.match(body, /if \(S\.busy\) \{/);
  assert.match(body, /MODE_REASSERT = \{ mode: id, timer: setInterval/);
});

test('agent side: POST /api/coding-mode has no busy gate and moves the live switches', () => {
  const route = readFileSync(new URL('../../src/http/route-coding-mode.ts', import.meta.url), 'utf8');
  const set = route.slice(route.indexOf('const set: HttpHandler'));
  assert.match(set, /ctx\.runtime\.setApprovalLevel\(resolved\.approvalLevel\)/);
  assert.match(set, /ctx\.runtime\.setPlanMode\(resolved\.planMode\)/);
  assert.doesNotMatch(set, /isBusy|busy/);
  // Read per tool call: the plan flag through a getter, the level on the gate itself.
  const boot = readFileSync(new URL('../../src/runtime/bootstrap.ts', import.meta.url), 'utf8');
  assert.match(boot, /isPlanMode: \(\) => planMode/);
  assert.match(boot, /setApprovalLevel: \(level\) => approvals\.setLevel\(level\)/);
});

test('loaded before renderer.js', () => {
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = html.indexOf('src="mode-mid-turn.js"');
  assert.ok(at > 0 && at < html.indexOf('src="renderer.js"'));
});
