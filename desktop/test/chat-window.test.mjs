// ATO-1272 / ATO-1273: the transcript window and the picture cache it bounds (renderer/chat-window.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const W = require('../renderer/chat-window.js');
const { turnFoldsOf } = require('../renderer/turn-summary.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const ic = (n) => '<i data-ic="' + n + '"></i>';

/** `turns` finished turns, each a question, `steps` tool rows and a reply. */
function chat(turns, steps = 0, prefix = 't') {
  const log = [];
  for (let t = 0; t < turns; t++) {
    log.push({id: prefix + t + 'u', k: 'user', text: 'q' + t});
    for (let s = 0; s < steps; s++) log.push({id: prefix + t + 's' + s, k: 'tool', name: 'tool' + s, ok: true});
    log.push({id: prefix + t + 'a', k: 'assistant', text: 'a' + t});
  }
  return log;
}

function fresh() {
  W.CHAT_WIN.log = null;
}

test('a short chat is drawn whole', () => {
  const log = chat(5, 2);
  assert.equal(W.chatWindowStart(log, {}), 0);
  assert.equal(W.chatWindowMoreHTML(log, 0, {esc, ic}), '');
  assert.equal(W.chatWindowStart([], {}), 0);
});

test('a long chat draws its last turns, from a question', () => {
  const log = chat(100);
  const from = W.chatWindowStart(log, {turns: 30, rows: 1000});
  assert.equal(log[from].id, 't70u');
  assert.equal(log.length - from, 60);
});

test('rows are capped too, so one huge running turn stays bounded', () => {
  const log = [{id: 'u', k: 'user', text: 'go'}];
  for (let i = 0; i < 5000; i++) log.push({id: 's' + i, k: 'tool', name: 'n' + (i % 2), ok: null});
  const from = W.chatWindowStart(log, {turns: 30, rows: 300});
  assert.equal(log.length - from, 300);
});

test('folded steps of finished turns do not count against the row cap', () => {
  const log = chat(40, 20);   // 40 turns × 22 rows
  const folds = turnFoldsOf(log, {});
  const from = W.chatWindowStart(log, {turns: 30, rows: 300, folds, isOpen: () => false});
  // 30 turns × (question + summary-folded steps + reply) = 60 drawn rows, under the cap.
  assert.equal(log[from].id, 't10u');
  // The same chat with every turn open hits the row cap first.
  const open = W.chatWindowStart(log, {turns: 30, rows: 300, folds, isOpen: () => true});
  assert.ok(open > from);
  assert.equal(log[open].k, 'user', 'a cut inside a finished turn moves back to its question');
});

test('the window never starts inside a finished turn\'s fold', () => {
  const log = chat(3, 10);
  const folds = turnFoldsOf(log, {});
  // A floor in the middle of turn 1's steps reaches back to turn 1's question.
  const at = log.findIndex((m) => m.id === 't1s5');
  const from = W.chatWindowStart(log, {turns: 1, rows: 1000, folds, floor: at});
  assert.equal(log[from].id, 't1u');
});

test('chatWindowFor: holds still while you read, lets go at the bottom, starts over per chat', () => {
  fresh();
  const log = chat(100);
  const first = W.chatWindowFor(log, new Map(), () => false, true);
  assert.equal(log[first].id, 't70u');
  // Five more turns arrive while you are scrolled up: the first row stays.
  log.push(...chat(5, 0, 'n'));
  assert.equal(W.chatWindowFor(log, new Map(), () => false, false), first);
  // Back at the bottom: the window follows the end again.
  const after = W.chatWindowFor(log, new Map(), () => false, true);
  assert.equal(log[after].id, 't75u');
  // Another chat (a new array): the default window.
  const other = chat(40);
  assert.equal(other[W.chatWindowFor(other, new Map(), () => false, false)].id, 't10u');
});

test('Show earlier widens the window by one step, and the bottom shrinks it back', () => {
  fresh();
  const log = chat(100);
  W.chatWindowFor(log, new Map(), () => false, true);
  W.chatWindowMore();
  const wider = W.chatWindowFor(log, new Map(), () => false, false);
  assert.equal(log[wider].id, 't40u');
  assert.equal(log[W.chatWindowFor(log, new Map(), () => false, true)].id, 't70u');
});

test('a jump to a row above the window reaches back to it', () => {
  fresh();
  const log = chat(100);
  W.chatWindowFor(log, new Map(), () => false, true);
  assert.equal(W.chatWindowReveal(log, 't80a'), false, 'already in the window');
  assert.equal(W.chatWindowReveal(log, 'nope'), false);
  assert.equal(W.chatWindowReveal(log, 't12a'), true);
  const from = W.chatWindowFor(log, new Map(), () => false, false);
  assert.ok(from <= log.findIndex((m) => m.id === 't12a'));
  assert.equal(W.chatWindowReveal(chat(3), 't0u'), false, 'another chat\'s window is not moved');
});

test('the Show earlier row counts what is hidden, escaped', () => {
  const log = chat(10);
  const html = W.chatWindowMoreHTML(log, 4, {esc, ic});
  assert.match(html, /data-chatwin="more"/);
  assert.match(html, /Show 4 earlier messages/);
  assert.match(W.chatWindowMoreHTML(log, 1, {esc, ic}), /Show 1 earlier message</);
  const steps = [{id: 'a', k: 'tool'}, {id: 'b', k: 'tool'}];
  assert.match(W.chatWindowMoreHTML(steps, 1, {esc, ic}), /Show earlier steps/);
});

test('ATO-1273: only the window\'s rows keep their pictures in use', () => {
  const log = [
    {id: 'a', k: 'assistant', replyFiles: ['/old.png']},
    {id: 'b', k: 'tool', shotPic: '/shot-old.png'},
    {id: 'c', k: 'assistant', replyFiles: ['/new.png'], turnPics: ['/named.png']},
    {id: 'd', k: 'tool', shotPic: '/shot-new.png'},
  ];
  assert.deepEqual([...W.chatImagesInUseOf(log, 2)].sort(), ['/named.png', '/new.png', '/shot-new.png']);
  assert.equal(W.chatImagesInUseOf(log, 0).size, 5);
});

test('ATO-1273: off-window pictures leave the cache, oldest first; on-screen ones never', () => {
  const st = (n, used) => ({url: 'x'.repeat(n), used});
  const held = [['/a', st(10, 1)], ['/b', st(10, 5)], ['/c', st(10, 3)], ['/on', st(1000, 0)]];
  const inUse = new Set(['/on']);
  // Under both caps: nothing goes.
  assert.deepEqual(W.chatImagesToDrop(held, inUse, 10000, 3), []);
  // At most one off-window picture: the two least recently drawn go.
  assert.deepEqual(W.chatImagesToDrop(held, inUse, 10000, 1), ['/a', '/c']);
  // Over the size cap: off-window ones go until it fits; the on-screen one stays even if it alone is too big.
  assert.deepEqual(W.chatImagesToDrop(held, inUse, 1015, 10), ['/a', '/c']);
  assert.deepEqual(W.chatImagesToDrop(held, inUse, 5, 10), ['/a', '/c', '/b']);
});

test('the page loads chat-window.js before renderer.js, and renderer.js draws and trims with it', () => {
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = html.indexOf('src="chat-window.js"');
  assert.ok(at > 0 && at < html.indexOf('src="renderer.js"'));
  const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(renderer, /chatWindowFor\(items, folds, \(f\) => TURN_OPEN\.has\(f\.replyId\), !!S\.stick\)/);
  assert.match(renderer, /for \(let i = from; i < items\.length; i\+\+\)/);
  assert.match(renderer, /chatImagesInUseOf\(S\.log, CHAT_WIN\.log === S\.log \? CHAT_WIN\.from : 0\)/);
  assert.match(renderer, /chatImagesToDrop\(held, chatImagesInUse\(\), CHAT_IMG_KEEP_CHARS, CHAT_IMG_KEEP_OFF\)/);
  assert.match(renderer, /t\.closest\('\[data-chatwin\]'\)/);
});
