// ATO-2500: favourite models from the keyboard (renderer/model-favorites-keys.js):
// ⌘P / ⇧⌘P (Ctrl+P / Ctrl+Shift+P off macOS) walk the favourites, ⌘D (Ctrl+D) stars the focused picker row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const K = require('../renderer/model-favorites-keys.js');

const ev = (o) => Object.assign({metaKey: false, ctrlKey: false, altKey: false, shiftKey: false}, o);

test('on a Mac it is ⌘, never ⌃ (⌃P moves the caret up in a text field)', () => {
  assert.deepEqual(K.modelFavKeyIntent(ev({metaKey: true}), 'p', true), {cycle: 1});
  assert.deepEqual(K.modelFavKeyIntent(ev({metaKey: true, shiftKey: true}), 'P', true), {cycle: -1});
  assert.deepEqual(K.modelFavKeyIntent(ev({metaKey: true}), 'd', true), {star: true});
  assert.equal(K.modelFavKeyIntent(ev({ctrlKey: true}), 'p', true), null);
  assert.equal(K.modelFavKeyIntent(ev({ctrlKey: true}), 'd', true), null);
});

test('on Windows and Linux it is Ctrl; Alt and the other modifier stand it down', () => {
  assert.deepEqual(K.modelFavKeyIntent(ev({ctrlKey: true}), 'p', false), {cycle: 1});
  assert.deepEqual(K.modelFavKeyIntent(ev({ctrlKey: true, shiftKey: true}), 'P', false), {cycle: -1});
  assert.deepEqual(K.modelFavKeyIntent(ev({ctrlKey: true}), 'd', false), {star: true});
  assert.equal(K.modelFavKeyIntent(ev({metaKey: true}), 'p', false), null);
  assert.equal(K.modelFavKeyIntent(ev({ctrlKey: true, altKey: true}), 'p', false), null);
  assert.equal(K.modelFavKeyIntent(ev({ctrlKey: true, shiftKey: true}), 'd', false), null);
  assert.equal(K.modelFavKeyIntent(ev({ctrlKey: true}), 'k', false), null);
  assert.equal(K.modelFavKeyIntent(ev({}), 'p', false), null);
});

test('the step wraps both ways; off the list the first is next and the last previous', () => {
  const keys = ['openai|gpt-5', 'local-llama|qwen3-8b', 'openrouter|a/b'];
  assert.deepEqual(K.modelFavStep(keys, 'openai|gpt-5', 1), {key: 'local-llama|qwen3-8b', index: 1, size: 3});
  assert.deepEqual(K.modelFavStep(keys, 'openrouter|a/b', 1), {key: 'openai|gpt-5', index: 0, size: 3});
  assert.deepEqual(K.modelFavStep(keys, 'openai|gpt-5', -1), {key: 'openrouter|a/b', index: 2, size: 3});
  assert.deepEqual(K.modelFavStep(keys, '', 1), {key: 'openai|gpt-5', index: 0, size: 3});
  assert.deepEqual(K.modelFavStep(keys, 'x|y', -1), {key: 'openrouter|a/b', index: 2, size: 3});
  assert.equal(K.modelFavStep([], '', 1), null);
  assert.deepEqual(K.modelFavSplit('openrouter|anthropic/claude'), {provider: 'openrouter', id: 'anthropic/claude'});
  assert.equal(K.modelFavSplit('nobar'), null);
});

test('the page loads it before renderer.js, the keydown asks it first, and the sheet lists the keys', () => {
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = html.indexOf('src="model-favorites-keys.js"');
  assert.ok(at > html.indexOf('src="model-favorites.js"') && at < html.indexOf('src="renderer.js"'));
  const r = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(r, /if \(chordKey\(e, sk\)\) return;\n  if \(typeof modelFavKeydown === 'function' && modelFavKeydown\(e, sk\)\) return;/);
  assert.match(r, /\['Next favorite model','⌘ P','Ctrl P'\],\['Previous favorite model','⇧ ⌘ P','Ctrl ⇧ P'\],\['Star the model row in focus','⌘ D','Ctrl D'\]/);
  // Nothing else in the page's shortcut map or the app menu takes P or D with the modifier.
  assert.doesNotMatch(r, /map = \{[^}]*\bp:/);
  assert.doesNotMatch(r, /map = \{[^}]*\bd:/);
  const menu = readFileSync(new URL('../main/menu.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(menu, /CommandOrControl\+P"|CommandOrControl\+D"|alt\("P"\)|alt\("D"\)/);
});
