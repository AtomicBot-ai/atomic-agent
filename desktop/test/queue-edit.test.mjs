// ATO-2132: Edit on a queued message above the composer (renderer/queue-edit.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Q = require('../renderer/queue-edit.js');
const SRC = readFileSync(new URL('../renderer/queue-edit.js', import.meta.url), 'utf8');
const ATT = readFileSync(new URL('../renderer/attachments.js', import.meta.url), 'utf8');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const ic = (n) => '<svg data-i="' + n + '"></svg>';
const BLOCK = '\n\n[attachments]\n- /u/.atomic-agent/inbox/desktop/2026-11-27/101500-shot.png (image/png, 12 KB)';
const split = (text) => (text.indexOf('[attachments]') > 0
  ? {caption: text.slice(0, text.indexOf('\n\n[attachments]')).replace(/^The user sent a file without a message\.$/, ''), items: [{path: 'p'}]}
  : null);

test('words only are edited: an attachments block stays byte for byte', () => {
  const msg = 'look at this' + BLOCK;
  const parts = Q.qeditParts(msg, split(msg));
  assert.equal(parts.caption, 'look at this');
  assert.equal(parts.tail, BLOCK);
  assert.equal(Q.qeditRebuild(parts, '  look at this one  '), 'look at this one' + BLOCK);
});

test('files with no words left keep the stand-in line; nothing left at all is a removal', () => {
  const msg = 'look' + BLOCK;
  assert.equal(Q.qeditRebuild(Q.qeditParts(msg, split(msg)), '   '), 'The user sent a file without a message.' + BLOCK);
  assert.equal(Q.qeditRebuild(Q.qeditParts('plain words', null), ''), '');
  assert.equal(Q.qeditRebuild(Q.qeditParts('plain words', null), 'new words'), 'new words');
});

test('pulling a message out keeps the STEER.ahead watermark, and it goes back on its own side', () => {
  const q = ['steer a', 'steer b', 'backlog c', 'backlog d'];
  const got = Q.qeditPull(q, 0, 2);
  assert.deepEqual(got, {text: 'steer a', wasAhead: true, ahead: 1});
  assert.deepEqual(q, ['steer b', 'backlog c', 'backlog d']);
  assert.equal(Q.qeditPutAt(q, 0, 1, true), 0);
  const b = ['steer a', 'backlog c'];
  assert.equal(Q.qeditPutAt(b, 0, 1, false), 1, 'backlog never goes ahead of a parked steer');
  assert.equal(Q.qeditPutAt([], 3, 0, false), 0, 'the queue drained meanwhile: the end');
  assert.equal(Q.qeditPull(['a'], 4, 0), null);
});

test('the chip markup: Edit on each chip, a field with Save and Cancel on the one being edited', () => {
  assert.match(Q.qeditButtonHTML(2, {esc, ic}), /data-qedit="2"[^>]*aria-label="Edit"/);
  const html = Q.qeditChipHTML({value: 'a <b>', parts: {files: 2}}, {esc, ic});
  assert.match(html, /<textarea id="qedit-field"[^>]*data-qedit-field="1"[^>]*>a &lt;b&gt;<\/textarea>/);
  assert.match(html, /2 files/);
  assert.match(html, /data-qedit="save"[^>]*>Save</);
  assert.match(html, /data-qedit="cancel"/);
  assert.doesNotMatch(html, /\u2014/);
});

/* The renderer side, against a small fake of renderer.js's queue state. */
function world(over) {
  const calls = {render: 0, drain: 0, unqueue: [], park: []};
  const c = vm.createContext(Object.assign({
    S: {queued: [], busy: true, pending: null},
    STEER: {ahead: 0},
    DRAIN_OWED: false,
    KEY: 's1',
    RUNNING: true,
    queueKey() { return c.KEY; },
    queueOwner(k) { return k; },
    queueChatRunning() { return c.RUNNING; },
    attSplitMessage: split,
    render() { calls.render++; },
    drainOwed() { calls.drain++; },
    unqueueMessage(at) { calls.unqueue.push(at); c.S.queued.splice(at, 1); },
    parkIn(key, texts) { calls.park.push([key, texts]); },
  }, over || {}));
  vm.runInContext(SRC + '\nglobalThis.QE = QEDIT;', c);
  c.calls = calls;
  return c;
}

test('while edited the message is out of the queue: a turn end cannot send it, and Save puts the edit back in place', () => {
  const w = world();
  w.S.queued.push('first', 'second', 'third');
  w.qeditStart(1);
  assert.deepEqual([...w.S.queued], ['first', 'third'], 'out of the queue while the field is open');
  assert.equal(w.qeditOn(), true);
  // The running turn ended and drainQueued sent the head of the queue: not the message in the field.
  assert.equal(w.S.queued.shift(), 'first');
  w.QE.value = 'second, fixed';
  w.qeditClick('save');
  assert.deepEqual([...w.S.queued], ['third', 'second, fixed'], 'back once, at its old place clamped to the shorter queue');
  assert.equal(w.QE.open, false);
});

test('Save goes back at the old index, clamped, and a second Save sends nothing twice', () => {
  const w = world();
  w.S.queued.push('first', 'second', 'third');
  w.qeditStart(1);
  w.QE.value = 'second, fixed';
  assert.equal(w.qeditFinish(true), 1);
  assert.deepEqual([...w.S.queued], ['first', 'second, fixed', 'third']);
  assert.equal(w.qeditFinish(true), -1, 'already closed');
  assert.equal(w.S.queued.length, 3);
  assert.equal(w.calls.drain, 0, 'the chat still runs its turn: the message waits for its end');
});

test('Cancel (and Escape) put the original back untouched, files and all', () => {
  const w = world();
  const msg = 'with a file' + BLOCK;
  w.S.queued.push(msg);
  w.qeditStart(0);
  assert.equal(w.QE.value, 'with a file');
  w.qeditInput({target: {dataset: {qeditField: '1'}, value: 'something else'}});
  let prevented = false;
  assert.equal(w.qeditKeydown({key: 'Escape', target: {dataset: {qeditField: '1'}}, preventDefault() { prevented = true; }, stopPropagation() {}}), true);
  assert.equal(prevented, true);
  assert.deepEqual([...w.S.queued], [msg]);
});

test('Enter saves with the files kept; Shift+Enter is left to the field', () => {
  const w = world();
  w.S.queued.push('typo' + BLOCK);
  w.qeditStart(0);
  w.qeditInput({target: {dataset: {qeditField: '1'}, value: 'fixed'}});
  const ev = (shiftKey) => ({key: 'Enter', shiftKey, target: {dataset: {qeditField: '1'}}, preventDefault() {}, stopPropagation() {}});
  assert.equal(w.qeditKeydown(ev(true)), false);
  assert.equal(w.qeditKeydown(ev(false)), true);
  assert.deepEqual([...w.S.queued], ['fixed' + BLOCK]);
});

test('the turn ended while the field was open: the saved message runs now instead of waiting forever', () => {
  const w = world();
  w.S.queued.push('only one');
  w.qeditStart(0);
  w.RUNNING = false; w.S.busy = false;   // the turn ended; the queue was empty, so nothing was left to run it
  w.qeditFinish(true);
  assert.equal(w.DRAIN_OWED, true);
  assert.equal(w.calls.drain, 1);
  assert.deepEqual([...w.S.queued], ['only one']);
});

test('everything deleted is a removal through unqueueMessage (its files go too)', () => {
  const w = world();
  w.S.queued.push('a', 'b');
  w.qeditStart(1);
  w.QE.value = '  ';
  w.qeditFinish(true);
  assert.deepEqual(w.calls.unqueue, [1]);
  assert.deepEqual([...w.S.queued], ['a']);
});

test('leaving the chat keeps what was typed and paints nothing; a deleted chat drops it', () => {
  const w = world();
  w.S.queued.push('a');
  w.qeditStart(0);
  w.QE.value = 'a, edited';
  const renders = w.calls.render;
  w.qeditLeave();
  assert.deepEqual([...w.S.queued], ['a, edited']);
  assert.equal(w.calls.render, renders, 'stashQueue paints after the switch, not here');
  w.qeditStart(0);
  w.qeditDrop('s1');
  assert.equal(w.QE.open, false);
  assert.deepEqual([...w.S.queued], []);
});

test('a window closed with the field open still keeps the message (queuesSnapshot)', () => {
  const w = world();
  w.S.queued.push('a', 'b');
  w.qeditStart(0);
  const out = w.qeditSnapshot({s1: ['b']}, 's1');
  assert.deepEqual([...out.s1], ['a', 'b']);
});

test('opening a second chip puts the first back and opens the right one', () => {
  const w = world();
  w.S.queued.push('a', 'b', 'c');
  w.qeditStart(0);           // queue on screen: b, c
  w.QE.value = 'a2';
  w.qeditStart(1);           // the person clicked "c" (index 1 of what they saw)
  assert.equal(w.QE.original, 'c');
  assert.deepEqual([...w.S.queued], ['a2', 'b']);
});

test('wiring: loaded before renderer.js, drawn in the tray, keys, input, clicks, paint and queue moves hooked', () => {
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('src="queue-edit.js"') > 0 && html.indexOf('src="queue-edit.js"') < html.indexOf('src="renderer.js"'));
  const r = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(r, /\(S\.queued\.length \|\| qeditOn\(\)\) \? '<div class="qtray">' \+ qeditTray\(S\.queued\.map\(/);
  assert.match(r, /\+ qeditButtonHTML\(i, \{esc, ic\}\)/);
  assert.match(r, /closest\('\[data-qedit\]'\)[^\n]*qeditClick\(qe\.dataset\.qedit\)/);
  assert.match(r, /fzpKeydown\(e\)\) return;\n\s*if \(typeof qeditKeydown === 'function' && qeditKeydown\(e\)\) return;/);
  assert.match(r, /qeditInput\(e\)\) return;/);
  assert.match(r, /const qeHeld = [^\n]*qeditHold\(\)[\s\S]*?qeditRestore\(qeHeld\)/);
  assert.match(r, /function stashQueue\(\) \{\n\s*qeditLeave\(\);/);
  assert.match(r, /function forgetQueue\(sid\) \{\n\s*qeditDrop\(sid\);/);
  assert.match(r, /return qeditSnapshot\(out, here\);/);
  // The real attachments format round-trips through the edit.
  const c = vm.createContext({});
  vm.runInContext(ATT + '\n' + SRC + '\nglobalThis.out = (() => { const m = attBuildMessage("hi", [{path: "/u/.atomic-agent/inbox/desktop/2026-11-27/101500-a.png", mimeType: "image/png", bytes: 2048}]);'
    + ' const p = qeditParts(m, attSplitMessage(m)); return {m, p, again: qeditRebuild(p, p.caption), blank: qeditRebuild(p, "")}; })();', c);
  assert.equal(c.out.p.caption, 'hi');
  assert.equal(c.out.again, c.out.m);
  assert.ok(c.attSplitMessage(c.out.blank), 'a blank caption still parses as a message with its file');
  assert.equal(c.attSplitMessage(c.out.blank).caption, '');
});
