// ATO-2476: reorder the queued messages above the composer (renderer/queue-reorder.js):
// drag with a drop bar, Alt+arrow on a focused chip, "Send next"; plus the
// counter and restart guard that missed a message being edited (ATO-2132 leftovers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const R = require('../renderer/queue-reorder.js');
const SRC = readFileSync(new URL('../renderer/queue-reorder.js', import.meta.url), 'utf8');
const EDIT = readFileSync(new URL('../renderer/queue-edit.js', import.meta.url), 'utf8');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const ic = (n) => '<svg data-i="' + n + '"></svg>';

test('a move keeps the order of the rest, and the STEER.ahead watermark stays a prefix', () => {
  const q = ['s1', 's2', 'b1', 'b2'];
  assert.equal(R.qorderMove(q, 3, 0, 2), 3, 'a backlog message put in front joins the parked steers');
  assert.deepEqual(q, ['b2', 's1', 's2', 'b1']);
  const p = ['s1', 's2', 'b1', 'b2'];
  assert.equal(R.qorderMove(p, 0, 3, 2), 1, 'a steer moved to the back leaves them');
  assert.deepEqual(p, ['s2', 'b1', 'b2', 's1']);
  const o = ['s1', 's2', 'b1'];
  assert.equal(R.qorderMove(o, 0, 1, 2), 2, 'moved inside the steers: still one of them');
  assert.deepEqual(o, ['s2', 's1', 'b1']);
  const n = ['a', 'b', 'c'];
  assert.equal(R.qorderMove(n, 2, 0, 0), 0, 'no steers: no watermark');
  assert.deepEqual(n, ['c', 'a', 'b']);
  assert.equal(R.qorderMove(['a'], 3, 0, 0), null, 'out of range');
  assert.equal(R.qorderMove(['a', 'b'], 1, 9, 0), 0, 'clamped to the end: no move');
});

test('keyboard steps and drops go round the field of a message being edited as it looks on screen', () => {
  // Screen: a, [field], c (S.queued a, c; QEDIT.at 1).
  assert.deepEqual(R.qorderStep(1, 2, -1, 1), {to: 1, after: false}, 'c up: it only hops the field');
  assert.equal(R.qorderEditAt(1, 1, 1, false), 2, 'screen: a, c, [field]');
  assert.deepEqual(R.qorderStep(0, 2, 1, 1), {to: 0, after: true}, 'a down: it only hops the field');
  assert.equal(R.qorderEditAt(1, 0, 0, true), 0, 'screen: [field], a, c');
  // Screen: a, b, [field], c: b up swaps with a and the field stays behind both.
  assert.deepEqual(R.qorderStep(1, 3, -1, 2), {to: 0, after: true});
  assert.equal(R.qorderEditAt(2, 1, 0, true), 2);
  assert.equal(R.qorderStep(0, 3, -1, -1), null, 'first already');
  assert.equal(R.qorderStep(2, 3, 1, -1), null, 'last already');
  assert.deepEqual(R.qorderStep(2, 3, 1, 3), {to: 2, after: true}, 'last of S.queued, the field after it: hop');
  // Drops: a dragged onto the left half of c, with the field right before c, lands between the field and c.
  assert.deepEqual(R.qorderDropPlan(0, 1, 'before', 1), {to: 0, after: true});
  assert.equal(R.qorderDropPlan(0, 0, 'after', 1), null, 'dropped on itself: nothing moves');
  assert.equal(R.qorderDropPlan(0, 1, 'before', -1), null, 'right before its neighbour, no field: nothing moves');
  assert.deepEqual(R.qorderDropPlan(0, 2, 'after', -1), {to: 2, after: false});
  assert.deepEqual(R.qorderDropPlan(2, 0, 'before', -1), {to: 0, after: true});
});

test('Send next is offered on every chip not drawn first', () => {
  assert.equal(R.qorderNextShown(0, -1), false);
  assert.equal(R.qorderNextShown(1, -1), true);
  assert.equal(R.qorderNextShown(0, 0), true, 'the field is drawn first: the chip after it can still go in front');
  assert.equal(R.qorderScreenAt(2, 1), 3);
});

test('the chip markup: draggable, focusable, named by its place, Option on a Mac; Send next is a labelled button', () => {
  const html = R.qorderChipOpen(1, 3, -1, 'fix <the> typo', {esc});
  assert.match(html, /^<div class="qchip" draggable="true" tabindex="0" data-qchip="1"/);
  assert.match(html, /aria-label="Queued message 2 of 3: fix &lt;the&gt; typo"/);
  assert.match(html, /press Alt and an arrow key/);
  assert.match(R.qorderChipOpen(0, 1, 0, 'x', {esc, mac: true}), /press Option and an arrow key[^>]*aria-label="Queued message 2 of 2: x"/);
  R.QORDER.over = 2; R.QORDER.side = 'after';
  assert.match(R.qorderChipOpen(2, 3, -1, 'x', {esc}), /class="qchip is-drop-after"/, 'the drop bar survives a repaint');
  R.QORDER.over = -1; R.QORDER.side = '';
  const b = R.qorderNextButtonHTML(2, {esc, ic});
  assert.match(b, /data-qnext="2"[^>]*aria-label="Send next"/);
  assert.match(b, /data-i="up"/);
  for (const s of [html, b]) assert.doesNotMatch(s, /\u2014/);
});

/* The renderer side, against a small fake of renderer.js's queue state. */
function world() {
  const calls = {render: 0, drain: 0, anx: []};
  const c = vm.createContext({
    S: {queued: [], busy: true, pending: null},
    STEER: {ahead: 0}, DRAIN_OWED: false, KEY: 's1', RUNNING: true,
    ANX: {messageAction(a) { calls.anx.push(a); }},
    queueKey() { return c.KEY; }, queueOwner(k) { return k; }, queueChatRunning() { return c.RUNNING; },
    attSplitMessage: () => null, attQueueLabel: (t) => t, esc, ic,
    render() { calls.render++; }, drainOwed() { calls.drain++; },
    unqueueMessage(at) { c.S.queued.splice(at, 1); }, parkIn() {},
  });
  vm.runInContext(EDIT + '\n' + SRC + '\nglobalThis.QE = QEDIT; globalThis.QO = QORDER;', c);
  c.calls = calls;
  return c;
}
const key = (k, i) => ({key: k, altKey: true, target: {dataset: {qchip: String(i)}, closest: () => ({dataset: {qchip: String(i)}})},
  preventDefault() {}, stopPropagation() {}});

test('Send next puts the message at the front, repaints and counts as a message action', () => {
  const w = world();
  w.S.queued.push('a', 'b', 'c');
  assert.equal(w.queueSendNext(2), true);
  assert.deepEqual([...w.S.queued], ['c', 'a', 'b']);
  assert.equal(w.calls.render, 1);
  assert.deepEqual(w.calls.anx, ['send_next']);
  assert.equal(w.queueSendNext(0), false, 'already first: nothing to do');
  assert.deepEqual(w.calls.anx, ['send_next']);
});

test('Alt+Up and Alt+Down move the focused chip one place and keep the focus on it; other keys are not ours', () => {
  const w = world();
  w.S.queued.push('a', 'b', 'c');
  assert.equal(w.qorderKeydown(key('ArrowUp', 1)), true);
  assert.deepEqual([...w.S.queued], ['b', 'a', 'c']);
  assert.equal(w.QO.focus, 0, 'the moved chip gets the focus back after the repaint');
  assert.deepEqual(w.calls.anx, ['reorder_queued']);
  assert.equal(w.qorderKeydown(key('ArrowDown', 1)), true);
  assert.deepEqual([...w.S.queued], ['b', 'c', 'a']);
  assert.equal(w.qorderKeydown(key('ArrowDown', 2)), true, 'already last: the key is still taken, nothing moves');
  assert.deepEqual([...w.S.queued], ['b', 'c', 'a']);
  assert.equal(w.qorderKeydown(Object.assign(key('ArrowUp', 1), {altKey: false})), false);
  assert.equal(w.qorderKeydown(Object.assign(key('ArrowUp', 1), {metaKey: true})), false);
  assert.equal(w.qorderKeydown(Object.assign(key('ArrowUp', 1), {target: {dataset: {}, closest: () => null}})), false);
});

test('with a message being edited, the others move round its field and the field keeps its words', () => {
  const w = world();
  w.S.queued.push('a', 'b', 'c');
  w.qeditStart(1);                      // screen: a, [b], c
  w.QE.value = 'b, fixed';
  w.qorderKeydown(key('ArrowUp', 1));   // c up: only hops the field
  assert.deepEqual([...w.S.queued], ['a', 'c']);
  assert.equal(w.QE.at, 2);
  w.qeditFinish(true);
  assert.deepEqual([...w.S.queued], ['a', 'c', 'b, fixed']);
  assert.ok(w.calls.anx.includes('edit_queued'), 'a saved edit is counted');
});

test('a message put in front of a field that held the queue back runs when the chat is idle', () => {
  const w = world();
  w.S.queued.push('a', 'b');
  w.qeditStart(0);                      // the head is in the field: the drain waits
  assert.equal(w.qeditHoldsDrain(), true);
  w.queueSendNext(0);                   // b to the front, ahead of the field
  assert.equal(w.QE.at, 1);
  assert.equal(w.qeditHoldsDrain(), false);
  assert.equal(w.calls.drain, 1, 'drainOwed is asked; it sends only when the chat can take it');
});

test('editing analytics: a saved change counts once, cancel or an unchanged save does not', () => {
  const w = world();
  w.S.queued.push('a');
  w.qeditStart(0); w.qeditFinish(false);
  w.qeditStart(0); w.qeditFinish(true);
  assert.deepEqual(w.calls.anx, []);
  w.qeditStart(0); w.QE.value = 'a2'; w.qeditFinish(true);
  assert.deepEqual(w.calls.anx, ['edit_queued']);
});

test('the sidebar counter and the restart guard still count a message while its edit field is open', () => {
  const ts = createRequire(import.meta.url)('typescript');
  const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('renderer.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fns = new Map(ast.statements.filter(ts.isFunctionDeclaration).map((n) => [n.name.text, n.getText(ast)]));
  const w = world();
  w.QUEUES = new Map();
  vm.runInContext(fns.get('chatQueuedCount') + '\n' + fns.get('anyChatQueued'), w);
  w.S.queued.push('only one');
  w.qeditStart(0);
  assert.equal(w.S.queued.length, 0, 'the message is out of S.queued while edited');
  assert.equal(w.chatQueuedCount('s1'), 1);
  assert.equal(w.anyChatQueued(), true);
});

test('wiring: loaded between queue-edit.js and renderer.js; tray, clicks, keys, paint hooked; analytics allows the actions', () => {
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = html.indexOf('src="queue-reorder.js"');
  assert.ok(at > html.indexOf('src="queue-edit.js"') && at < html.indexOf('src="renderer.js"'));
  const r = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(r, /qeditTray\(S\.queued\.map\(\(t, i\) =>[^\n]*\n\s*qorderChip\(i, t\) \+ '<span class="qlb">'/);
  assert.match(r, /\+ qorderNext\(i\)[^\n]*\n\s*\+ qeditButtonHTML\(i, \{esc, ic\}\)/);
  assert.match(r, /closest\('\[data-qnext\]'\); if \(qn\) \{ queueSendNext\(\+qn\.dataset\.qnext\); return; \}/);
  assert.match(r, /qeditKeydown\(e\)\) return;[^\n]*\n\s*if \(typeof qorderKeydown === 'function' && qorderKeydown\(e\)\) return;/);
  assert.match(r, /const qoHeld = [^\n]*qorderHold\(\)[\s\S]*?qorderRestore\(qoHeld\)/);
  const cat = readFileSync(new URL('../main/analytics/catalog.ts', import.meta.url), 'utf8');
  const line = cat.slice(cat.indexOf('message_action:'), cat.indexOf('approval_answered:'));
  for (const a of ['edit_queued', 'reorder_queued', 'send_next']) assert.match(line, new RegExp('"' + a + '"'));
  const css = readFileSync(new URL('../renderer/css/composer.css', import.meta.url), 'utf8');
  assert.match(css, /\.qchip\.is-drop-before::before/);
  assert.match(css, /\.qorder-sr\{/);
});
