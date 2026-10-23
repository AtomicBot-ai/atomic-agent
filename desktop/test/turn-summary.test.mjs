import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {STEPS, stepsAlwaysSet, turnFoldable, turnFoldsOf, turnSumLabel, turnSumHTML} =
  createRequire(import.meta.url)('../renderer/turn-summary.js');

// ATO-464 (U-42): a finished turn's steps fold into one summary line.

let n = 0;
const row = (k, extra) => Object.assign({id: 'r' + (++n), k}, extra);
const user = (extra) => row('user', Object.assign({text: 'q'}, extra));
const reply = (extra) => row('assistant', Object.assign({text: 'Done!'}, extra));
const reason = () => row('reason', {text: 'thinking', open: false});
const tool = (extra) => row('tool', Object.assign({name: 'os.fs.write', ok: true, open: false}, extra));
const approval = (state) => row('approval', {state, tool: 'os.fs.write'});
const deps = {esc: (s) => String(s), ic: (name) => '<svg data-ic="' + name + '"></svg>', dur: (ms) => (ms / 1000).toFixed(1) + ' s'};

test('the audit turn (4 reasoning rows, 3 calls, 2 approvals) folds all nine rows into one line', () => {
  const log = [user(), reason(), tool(), approval('approved'), reason(), tool(), approval('approved'), reason(), tool(), reason(), reply()];
  const folds = turnFoldsOf(log, {});
  assert.equal(folds.size, 1);
  const f = folds.get(1);
  assert.deepEqual(f.rows, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(f.replyId, log[10].id);
  assert.deepEqual({tools: f.tools, reasons: f.reasons, approvals: f.approvals, failed: f.failed}, {tools: 3, reasons: 4, approvals: 2, failed: 0});
  assert.equal(turnSumLabel(f), 'Used 3 tools');
});

test('the turn still streaming is drawn as it is', () => {
  const log = [user(), reason(), tool(), reply({text: ''})];
  assert.equal(turnFoldsOf(log, {runningId: log[3].id}).size, 0);
  // Once it is over (no running reply), the same rows fold.
  assert.equal(turnFoldsOf(log, {runningId: null}).size, 1);
});

test('steps with no reply under them yet are not folded', () => {
  assert.equal(turnFoldsOf([user(), reason(), tool()], {}).size, 0);
});

test('Always show steps folds nothing', () => {
  const log = [user(), reason(), tool(), reply()];
  assert.equal(turnFoldsOf(log, {always: true}).size, 0);
});

test('one reasoning row alone stays a row; two fold as reasoning', () => {
  assert.equal(turnFoldsOf([user(), reason(), reply()], {}).size, 0);
  const folds = turnFoldsOf([user(), reason(), reason(), reply()], {});
  assert.equal(turnSumLabel(folds.get(1)), 'Reasoned in 2 steps');
});

test('a single call folds, and the label counts in the singular', () => {
  const folds = turnFoldsOf([user(), tool(), reply()], {});
  assert.equal(turnSumLabel(folds.get(1)), 'Used 1 tool');
});

test('words stay in sight: notes, system rows, a waiting approval and one the run left unanswered', () => {
  const log = [user(), reason(), row('interim', {text: 'halfway'}), tool(), approval(null), approval('stopped'), approval('expired'),
    row('system', {text: 'note'}), approval('denied'), tool({ok: false}), reply()];
  const f = turnFoldsOf(log, {}).get(1);
  assert.deepEqual(f.rows, [1, 3, 8, 9]);
  assert.equal(f.failed, 1);
  assert.equal(turnFoldable(log[4]), false);
  assert.equal(turnFoldable(log[5]), false);
  assert.equal(turnFoldable(log[6]), false);
  assert.equal(turnFoldable(log[8]), true);
});

test('a steer does not start a turn; the next real message does', () => {
  const log = [user(), tool(), user({steered: true}), tool(), reply(), user(), tool(), reply()];
  const folds = turnFoldsOf(log, {});
  assert.deepEqual([...folds.keys()], [1, 6]);
  assert.deepEqual(folds.get(1).rows, [1, 3]);
  assert.equal(folds.get(1).replyId, log[4].id);
});

test('steps after a reply that no message started are left alone', () => {
  assert.equal(turnFoldsOf([reply(), tool(), reply()], {}).size, 0);
});

test('the line: label, failures in red words, the time; closed or open', () => {
  const f = {replyId: 'abc', tools: 4, reasons: 2, approvals: 0, failed: 1, rows: []};
  const closed = turnSumHTML(f, false, 12000, deps);
  assert.match(closed, /data-turnsum="abc"/);
  assert.match(closed, /id="turnsum-abc"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /data-ic="chevR"/);
  assert.match(closed, /<span class="ts-l">Used 4 tools<\/span>/);
  assert.match(closed, /<span class="ts-bad">1 failed<\/span>/);
  assert.match(closed, /<span class="ts-du tnum">12\.0 s<\/span>/);
  const open = turnSumHTML(f, true, null, deps);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /data-ic="chevD"/);
  assert.doesNotMatch(open, /ts-du/);   // nothing measured: no number, never a zero
  assert.doesNotMatch(turnSumHTML(f, false, 0, deps), /ts-du/);
  assert.doesNotMatch(turnSumHTML(Object.assign({}, f, {failed: 0}), false, null, deps), /ts-bad/);
  assert.doesNotMatch(closed, /—/);
});

test('the setting flips and is off by default', () => {
  assert.equal(STEPS.always, false);
  stepsAlwaysSet(true);
  assert.equal(STEPS.always, true);
  stepsAlwaysSet(false);
  assert.equal(STEPS.always, false);
});

test('the page loads turn-summary.js before renderer.js, which draws with it', async () => {
  const {readFileSync} = await import('node:fs');
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = html.indexOf('src="turn-summary.js"');
  assert.ok(at > 0 && at < html.indexOf('src="renderer.js"'));
  const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  // The click goes through the document-level delegation, never a listener on the line itself.
  assert.match(renderer, /t\.closest\('\[data-turnsum\]'\)/);
  assert.match(renderer, /turnFoldsOf\(items, \{runningId: S\.turnId \? S\.streamId : null, always: STEPS\.always\}\)/);
});
