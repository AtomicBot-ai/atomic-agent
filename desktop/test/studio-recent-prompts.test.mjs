import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const R = req('../renderer/studio/recent-prompts.js');

/* ---------- list rules (ATO-809) ---------- */

test('a new prompt goes on top, trimmed', () => {
  assert.deepEqual(R.studioRecentAdd(['a fox'], '  a cat on a roof  '), ['a cat on a roof', 'a fox']);
});

test('sending a prompt again moves it up instead of listing it twice, whatever its case and spacing', () => {
  const list = ['a cat', 'A  fox\nat dawn', 'a dog'];
  assert.deepEqual(R.studioRecentAdd(list, 'a fox at DAWN'), ['a fox at DAWN', 'a cat', 'a dog']);
});

test('a blank prompt changes nothing', () => {
  assert.deepEqual(R.studioRecentAdd(['a fox'], '   '), ['a fox']);
  assert.deepEqual(R.studioRecentAdd(['a fox'], null), ['a fox']);
  assert.deepEqual(R.studioRecentAdd(null, ''), []);
});

test('the list keeps the newest STUDIO_RECENT_MAX and drops the oldest', () => {
  let list = [];
  for (let i = 1; i <= R.STUDIO_RECENT_MAX + 3; i++) list = R.studioRecentAdd(list, 'prompt ' + i);
  assert.equal(list.length, R.STUDIO_RECENT_MAX);
  assert.equal(list[0], 'prompt ' + (R.STUDIO_RECENT_MAX + 3));
  assert.equal(list[list.length - 1], 'prompt 4');
  assert.deepEqual(R.studioRecentAdd(['a', 'b', 'c'], 'd', 2), ['d', 'a']);
});

test('a stored value is read back clean: bad JSON, non-strings, blanks and repeats are dropped', () => {
  assert.deepEqual(R.studioRecentParse('not json'), []);
  assert.deepEqual(R.studioRecentParse('{"a":1}'), []);
  assert.deepEqual(R.studioRecentParse(null), []);
  assert.deepEqual(R.studioRecentParse(JSON.stringify(['a fox', 3, '', ' A FOX ', null, 'a cat'])), ['a fox', 'a cat']);
});

test('a prompt is kept at the contract limit of 8000 characters', () => {
  const long = 'x'.repeat(9000);
  assert.equal(R.studioRecentAdd([], long)[0].length, 8000);
});

test('a long or multi-line prompt shows as one shortened line', () => {
  assert.equal(R.studioRecentLabel('a fox\n\n at dawn'), 'a fox at dawn');
  const label = R.studioRecentLabel('word '.repeat(40), 20);
  assert.equal(label.length <= 20, true);
  assert.ok(label.endsWith('…'));
});

/* ---------- storage ---------- */

test('each page keeps its own list in localStorage, and a storage that throws is survived', () => {
  const store = new Map();
  // Node 25 has its own localStorage global: swap it with a configurable property and put it back after.
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const use = (value) => Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });
  use({ getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) });
  try {
    let images = R.studioRecentLoad('image');
    assert.deepEqual(images, []);
    images = R.studioRecentRemember('image', images, 'a fox');
    R.studioRecentRemember('video', [], 'a slow push-in');
    assert.deepEqual(R.studioRecentLoad('image'), ['a fox']);
    assert.deepEqual(R.studioRecentLoad('video'), ['a slow push-in']);
    assert.notEqual(R.studioRecentStoreKey('image'), R.studioRecentStoreKey('video'));

    use({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    assert.deepEqual(R.studioRecentLoad('image'), []);
    assert.deepEqual(R.studioRecentRemember('image', ['a fox'], 'a cat'), ['a cat', 'a fox']);
  } finally {
    delete globalThis.localStorage;
    if (before) Object.defineProperty(globalThis, 'localStorage', before);
  }
});

/* ---------- the chip and the list ---------- */

const attr = (v, a) => 'data-x="' + v + (a ? ':' + a : '') + '"';

test('nothing is drawn until a prompt has been sent', () => {
  assert.equal(R.studioRecentHTML([], false, attr), '');
  assert.equal(R.studioRecentHTML(null, true, attr), '');
});

test('closed: only the Recent chip; open: one button per prompt, escaped, with its index', () => {
  const closed = R.studioRecentHTML(['a fox'], false, attr);
  assert.match(closed, /data-x="recent"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(closed, /recent-use/);
  const open = R.studioRecentHTML(['a fox', '<b>"cat"</b>'], true, attr);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /data-x="recent-use:0"/);
  assert.match(open, /data-x="recent-use:1"/);
  assert.ok(open.includes('&lt;b&gt;&quot;cat&quot;&lt;/b&gt;'));
  assert.ok(!open.includes('<b>'));
});

/* ---------- wiring ---------- */

test('index.html loads recent-prompts.js before the Studio pages', () => {
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = (s) => index.indexOf('<script src="' + s + '">');
  assert.ok(at('studio/recent-prompts.js') > 0);
  for (const page of ['studio/images.js', 'studio/images-view.js', 'studio/video.js']) assert.ok(at('studio/recent-prompts.js') < at(page), page);
});

test('both pages remember the prompt after a generation starts and draw the list under the prompt box', () => {
  const images = readFileSync(new URL('../renderer/studio/images.js', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../renderer/studio/images-view.js', import.meta.url), 'utf8');
  const video = readFileSync(new URL('../renderer/studio/video.js', import.meta.url), 'utf8');
  assert.match(images, /studioRecentRemember\('image'/);
  assert.match(images, /case 'recent-use'/);
  assert.match(view, /studioRecentHTML\(IM\.recent/);
  assert.match(video, /studioRecentRemember\(KIND/);
  assert.match(video, /case 'recent-use'/);
  assert.match(video, /studioRecentHTML\(S\.recent/);
});

test('no em dash in the recent prompts text', () => {
  const src = readFileSync(new URL('../renderer/studio/recent-prompts.js', import.meta.url), 'utf8');
  const strings = src.match(/'[^'\n]*'/g) || [];
  assert.equal(strings.filter((s) => s.includes('—')).length, 0);
});
