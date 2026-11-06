// ATO-1249: the side panel's Steps and Reasoning, newest first, with a switch (renderer/insp-order.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const O = require('../renderer/insp-order.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

test('newest first by default, and the list is not changed in place', () => {
  assert.equal(O.INSP_ORDER.newestFirst, true);
  const list = ['a', 'b', 'c'];
  assert.deepEqual(O.inspOrdered(list), ['c', 'b', 'a']);
  assert.deepEqual(list, ['a', 'b', 'c']);
  assert.deepEqual(O.inspOrdered(null), []);
});

test('the switch flips the order and back', () => {
  O.inspOrderSet(false);
  assert.deepEqual(O.inspOrdered(['a', 'b']), ['a', 'b']);
  assert.match(O.inspOrderHTML(2, {esc}), />Oldest first</);
  assert.match(O.inspOrderHTML(2, {esc}), /title="Show the newest first"/);
  O.inspOrderSet(true);
  assert.deepEqual(O.inspOrdered(['a', 'b']), ['b', 'a']);
  assert.match(O.inspOrderHTML(2, {esc}), />Newest first</);
  assert.match(O.inspOrderHTML(2, {esc}), /data-act="inspord:toggle"/);
});

test('no switch over an empty or one-row list', () => {
  assert.equal(O.inspOrderHTML(0, {esc}), '');
  assert.equal(O.inspOrderHTML(1, {esc}), '');
});

test('newest first: the top follows new rows, a reader scrolled down keeps the rows they see', () => {
  const atTop = O.inspScrollKeep({scrollTop: 0, scrollHeight: 1000, clientHeight: 300}, true);
  assert.deepEqual(atTop, {at: 'start'});
  assert.equal(O.inspScrollTo(atTop, {scrollHeight: 1200}), 0);
  const reading = O.inspScrollKeep({scrollTop: 400, scrollHeight: 1000, clientHeight: 300}, true);
  // 200px of new rows above: the view moves down by as much.
  assert.equal(O.inspScrollTo(reading, {scrollHeight: 1200}), 600);
  assert.equal(O.inspScrollTo(reading, {scrollHeight: 100}), 0);
});

test('oldest first: the end follows new text, as before', () => {
  const atEnd = O.inspScrollKeep({scrollTop: 700, scrollHeight: 1000, clientHeight: 300}, false);
  assert.deepEqual(atEnd, {at: 'end'});
  assert.equal(O.inspScrollTo(atEnd, {scrollHeight: 1200}), 1200);
  const reading = O.inspScrollKeep({scrollTop: 100, scrollHeight: 1000, clientHeight: 300}, false);
  assert.equal(O.inspScrollTo(reading, {scrollHeight: 1200}), 100);
  assert.equal(O.inspScrollKeep(null, true), null);
  assert.equal(O.inspScrollTo(null, {scrollHeight: 10}), 0);
});

test('the page loads insp-order.js before renderer.js, and the panel lists with it', () => {
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = html.indexOf('src="insp-order.js"');
  assert.ok(at > 0 && at < html.indexOf('src="renderer.js"'));
  const r = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  // A step keeps its own number whichever way the list runs.
  assert.match(r, /inspOrdered\(tools\.map\(\(m, i\) => \[m, i\]\)\)\.map\(\(\[m, i\]\) =>/);
  assert.match(r, /inspOrdered\(r\)\.map\(\(m\) => '<div class="insp-rs"/);
  assert.match(r, /if \(k === 'inspord'\)\s+\{ inspOrderSet\(!INSP_ORDER\.newestFirst\);/);
  assert.match(r, /now\.scrollTop = inspScrollTo\(keep, now\)/);
});
