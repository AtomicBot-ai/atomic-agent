// ATO-2169: favourite models, starred in the composer's model picker and pinned at its top (renderer/model-favorites.js).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const F = require('../renderer/model-favorites.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const ic = (n) => '<svg data-ic="' + n + '"></svg>';

const cloud = (provider, id) => ({type: 'cloudModel', id, label: id, provider, group: provider, active: false});
const local = (id, downloaded) => ({type: 'localModel', id, label: id, downloaded, active: false, group: 'local-llama'});
const GROUPS = [
  {id: 'openai', title: 'OpenAI', busy: false, err: null},
  {id: 'local-llama', title: 'On this computer', busy: false, err: null},
  {id: 'openrouter', title: 'OpenRouter', busy: false, err: null},
];

beforeEach(() => { F.MODEL_FAV.keys.length = 0; });

test('a row names its favourite by provider and model; only models on hand can be one', () => {
  assert.equal(F.modelFavKey(cloud('openrouter', 'anthropic/claude-sonnet')), 'openrouter|anthropic/claude-sonnet');
  assert.equal(F.modelFavKey(local('qwen3-8b', true)), 'local-llama|qwen3-8b');
  assert.equal(F.modelFavKey(local('qwen3-32b', false)), '');
  assert.equal(F.modelFavKey({type: 'action', id: 'downloadMore'}), '');
  assert.equal(F.modelFavKey({type: 'backend', id: 'cloud'}), '');
  assert.equal(F.modelFavKey({type: 'cloudModel', id: 'gpt-5'}), '');
  assert.equal(F.modelFavKey(null), '');
});

test('the star turns a favourite on and off', () => {
  assert.equal(F.modelFavToggle('openai|gpt-5'), true);
  assert.equal(F.modelFavIs('openai|gpt-5'), true);
  assert.equal(F.modelFavToggle('openai|gpt-5'), false);
  assert.equal(F.modelFavIs('openai|gpt-5'), false);
  // Not a favourite key at all: nothing is stored.
  assert.equal(F.modelFavToggle('gpt-5'), false);
  assert.deepEqual(F.MODEL_FAV.keys, []);
});

test('the list is capped, the oldest star goes first', () => {
  for (let i = 0; i < F.MODEL_FAV_MAX + 3; i++) F.modelFavToggle('openai|m' + i);
  assert.equal(F.MODEL_FAV.keys.length, F.MODEL_FAV_MAX);
  assert.equal(F.MODEL_FAV.keys[0], 'openai|m3');
});

test('a stored list is cleaned of junk and repeats', () => {
  assert.deepEqual(F.modelFavClean(['openai|a', 'openai|a', 7, '|b', 'c|', 'nobar', null, 'local-llama|q']), ['openai|a', 'local-llama|q']);
  assert.deepEqual(F.modelFavClean('not a list'), []);
});

test('no favourite: the grouped list is exactly as before', () => {
  const rows = [cloud('openai', 'gpt-5'), local('qwen3-8b', true)];
  const pin = F.modelFavPin(GROUPS, rows);
  assert.equal(pin.groups, GROUPS);
  assert.equal(pin.rows, rows);
});

test('favourites are copied into a Favorites group at the top, in the order starred', () => {
  const rows = [cloud('openai', 'gpt-5'), cloud('openai', 'gpt-5-mini'), local('qwen3-8b', true), cloud('openrouter', 'gpt-5')];
  F.modelFavToggle('local-llama|qwen3-8b');
  F.modelFavToggle('openrouter|gpt-5');
  F.modelFavToggle('anthropic|claude-opus');   // a provider not in the list now: not drawn
  const pin = F.modelFavPin(GROUPS, rows);
  assert.deepEqual(pin.groups.map((g) => g.id), ['favorites', 'openai', 'local-llama', 'openrouter']);
  assert.equal(pin.groups[0].title, 'Favorites');
  assert.equal(pin.groups[0].fav, true);
  const favs = pin.rows.filter((r) => r.group === 'favorites');
  assert.deepEqual(favs.map((r) => r.provider || 'local-llama'), ['local-llama', 'openrouter']);
  assert.deepEqual(favs.map((r) => r.id), ['qwen3-8b', 'gpt-5']);
  // ATO-2500: a copy names whose model it is, from its own group's heading.
  assert.deepEqual(favs.map((r) => r.favFrom), ['On this computer', 'OpenRouter']);
  // Copies first, then every original row still in its own group.
  assert.equal(pin.rows.length, rows.length + 2);
  assert.deepEqual(pin.rows.slice(2), rows);
  // The originals are not moved or rewritten.
  assert.equal(rows[2].group, 'local-llama');
  assert.equal(rows[3].group, 'openrouter');
});

test('the same model id under another provider is not that favourite', () => {
  F.modelFavToggle('openrouter|gpt-5');
  const pin = F.modelFavPin(GROUPS, [cloud('openai', 'gpt-5')]);
  assert.deepEqual(pin.groups.map((g) => g.id), ['openai', 'local-llama', 'openrouter']);
});

test('the star: lit on a favourite, its own act, nothing on a row that cannot be one', () => {
  const r = cloud('openrouter', 'anthropic/claude-sonnet');
  const off = F.modelFavStarHTML(r, {esc, ic});
  assert.match(off, /data-act="sel:fav:openrouter\|anthropic\/claude-sonnet"/);
  assert.match(off, /class="selfav"/);
  assert.match(off, /aria-pressed="false"/);
  assert.match(off, /title="Add to favorites"/);
  assert.match(off, /data-ic="star"/);
  F.modelFavToggle('openrouter|anthropic/claude-sonnet');
  const on = F.modelFavStarHTML(r, {esc, ic});
  assert.match(on, /class="selfav on"/);
  assert.match(on, /title="Remove from favorites"/);
  assert.equal(F.modelFavStarHTML(local('big', false), {esc, ic}), '');
  assert.equal(F.modelFavStarHTML({type: 'action', id: 'downloadMore'}, {esc, ic}), '');
});

test('the page loads model-favorites.js before renderer.js, and the picker uses it', () => {
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = html.indexOf('src="model-favorites.js"');
  assert.ok(at > 0 && at < html.indexOf('src="renderer.js"'));
  const r = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(r, /const pin = typeof modelFavPin === 'function' \? modelFavPin\(groups, out\)/);
  assert.match(r, /SEL\.groups = pin\.groups;/);
  assert.match(r, /return pin\.rows;/);
  assert.match(r, /modelFavStarHTML\(r, \{esc, ic\}\)/);
  assert.match(r, /if \(a\.startsWith\('sel:fav:'\)\) \{ if \(typeof modelFavToggle === 'function'\) modelFavToggle\(a\.slice\('sel:fav:'\.length\), render\); render\(\); return; \}/);
  // The route's own group keeps the first group's lines under a Favorites group.
  assert.match(r, /const gi = gAt - favLead;/);
});

/* ---------------- ATO-2500 ---------------- */

const tick = () => new Promise((r) => setImmediate(r));

function fakeBridge(file) {
  const calls = [];
  return {
    calls,
    modelFavLoad: async (legacy) => { calls.push(['load', legacy]); for (const k of legacy || []) if (!file.includes(k)) file.push(k); return {ok: true, keys: [...file], saved: true}; },
    modelFavSet: async (key, on) => { calls.push(['set', key, on]); const at = file.indexOf(key); if (!on && at >= 0) file.splice(at, 1); else if (on && at < 0) file.push(key); return {ok: true, keys: [...file], on}; },
  };
}

function withWindow(br, storage, fn) {
  const had = {window: globalThis.window, localStorage: globalThis.localStorage};
  globalThis.window = {atomic: br};
  globalThis.localStorage = storage;
  return Promise.resolve(fn()).finally(() => {
    globalThis.window = had.window; globalThis.localStorage = had.localStorage;
    F.MODEL_FAV.shared = false;
  });
}

function memStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return {getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), has: (k) => m.has(k)};
}

test('ATO-2500: the old per-window list moves into the shared file once, then localStorage is dropped', async () => {
  const file = ['openai|gpt-5'];
  const br = fakeBridge(file);
  const store = memStorage({[F.MODEL_FAV_KEY]: JSON.stringify(['local-llama|qwen3-8b', 'openai|gpt-5'])});
  await withWindow(br, store, async () => {
    let changed = null;
    await F.modelFavSync((c) => { changed = c; });
    assert.deepEqual(br.calls[0], ['load', ['local-llama|qwen3-8b', 'openai|gpt-5']]);
    assert.deepEqual(F.MODEL_FAV.keys, ['openai|gpt-5', 'local-llama|qwen3-8b']);
    assert.equal(changed, true);
    assert.equal(F.MODEL_FAV.shared, true);
    assert.equal(store.has(F.MODEL_FAV_KEY), false);
    // The next open hands main nothing old to merge.
    await F.modelFavSync();
    assert.deepEqual(br.calls[1], ['load', []]);
  });
});

test('ATO-2500: a star goes to the shared file (not localStorage) and its answer is the list drawn', async () => {
  const file = ['anthropic|claude-opus'];   // starred in the terminal
  const br = fakeBridge(file);
  const store = memStorage();
  await withWindow(br, store, async () => {
    await F.modelFavSync();
    let repainted = 0;
    assert.equal(F.modelFavToggle('openai|gpt-5', () => { repainted++; }), true);
    await tick();
    assert.deepEqual(br.calls.at(-1), ['set', 'openai|gpt-5', true]);
    assert.deepEqual(F.MODEL_FAV.keys, ['anthropic|claude-opus', 'openai|gpt-5']);
    assert.equal(repainted, 1);
    assert.equal(store.has(F.MODEL_FAV_KEY), false);
  });
});

test('review D1: the window sends the state it drew; a star the terminal added while the picker was open is kept', async () => {
  const file = ['anthropic|claude-opus'];
  const br = fakeBridge(file);
  await withWindow(br, memStorage(), async () => {
    await F.modelFavSync();   // the picker opens: [claude-opus]
    file.push('openai|gpt-5');   // the terminal: /model favorite add openai/gpt-5
    // The window still draws gpt-5 unstarred; the click asks for "starred".
    assert.equal(F.modelFavToggle('openai|gpt-5', () => {}), true);
    await tick();
    assert.deepEqual(br.calls.at(-1), ['set', 'openai|gpt-5', true]);
    assert.deepEqual(F.MODEL_FAV.keys, ['anthropic|claude-opus', 'openai|gpt-5']);
    assert.deepEqual(file, ['anthropic|claude-opus', 'openai|gpt-5']);
    // And an unstar asks for "not starred".
    assert.equal(F.modelFavToggle('openai|gpt-5', () => {}), false);
    await tick();
    assert.deepEqual(br.calls.at(-1), ['set', 'openai|gpt-5', false]);
  });
});

test('ATO-2500: without the bridge the stars stay in localStorage, as before', async () => {
  const store = memStorage();
  await withWindow(null, store, async () => {
    assert.equal(F.modelFavBridge(), null);
    assert.equal(await F.modelFavSync(), false);
    F.modelFavToggle('openai|gpt-5');
    assert.equal(store.getItem(F.MODEL_FAV_KEY), JSON.stringify(['openai|gpt-5']));
  });
});

test('ATO-2500: picker rows: one data-id per model, the Download row leads its own group, the picker re-reads on open', () => {
  const r = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(r, /\(r\.favCopy \? 'data-fav-id' : 'data-id'\)/);
  assert.match(r, /const leads = r\.type === 'action' && \(i === 0 \|\| \(groups && rows\[i - 1\] && rows\[i - 1\]\.group !== r\.group\)\);/);
  assert.match(r, /\(r\.type === 'action' && !leads \? '<div class="tk-sep selsep"><\/div>' : ''\)/);
  assert.match(r, /\(leads && i \+ 1 < rows\.length \? '<div class="tk-sep selsep"><\/div>' : ''\)/);
  assert.match(r, /if \(typeof modelFavSync === 'function'\) modelFavSync\(\(changed\) => \{ if \(changed && SEL\.open\) render\(\); \}\);/);
});
