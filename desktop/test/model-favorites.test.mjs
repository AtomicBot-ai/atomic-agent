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
  assert.match(r, /if \(a\.startsWith\('sel:fav:'\)\) \{ if \(typeof modelFavToggle === 'function'\) modelFavToggle\(a\.slice\('sel:fav:'\.length\)\); render\(\); return; \}/);
  // The route's own group keeps the first group's lines under a Favorites group.
  assert.match(r, /const gi = gAt - favLead;/);
});
