// ATO-2500: one favourites list for the desktop and the terminal: the picker reads and
// writes <state dir>/model-favorites.json in the terminal's format (main/model-favorites-store.ts).
// Against the built output (npm run build first).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ST = require('../out/main/model-favorites-store.js');

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atomic-model-fav-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fileOf = () => JSON.parse(readFileSync(join(dir, ST.MODEL_FAVORITES_FILE), 'utf8'));

test('the window key and the file entry are the same favourite, split on the first separator', () => {
  assert.equal(ST.favKeyToEntry('openrouter|anthropic/claude'), 'openrouter/anthropic/claude');
  assert.equal(ST.favEntryToKey('openrouter/anthropic/claude'), 'openrouter|anthropic/claude');
  assert.equal(ST.favEntryToKey('local-llama/qwen3-8b'), 'local-llama|qwen3-8b');
  for (const bad of ['gpt-5', '|x', 'x|', 7, null, 'a b|c']) assert.equal(ST.favKeyToEntry(bad), null);
  assert.equal(ST.MODEL_FAVORITES_MAX, 20);
});

test('reads the file the terminal writes, and writes it back in that format', () => {
  writeFileSync(join(dir, ST.MODEL_FAVORITES_FILE), JSON.stringify({ models: ['openai/gpt-5', 'local-llama/qwen3-8b', 'junk', 'openai/gpt-5'] }));
  assert.deepEqual(ST.readFavKeys(dir), ['openai|gpt-5', 'local-llama|qwen3-8b']);
  assert.equal(ST.writeFavKeys(dir, ['openrouter|a/b', 'openai|gpt-5']), true);
  assert.deepEqual(fileOf(), { models: ['openrouter/a/b', 'openai/gpt-5'] });
  writeFileSync(join(dir, ST.MODEL_FAVORITES_FILE), '{not json');
  assert.deepEqual(ST.readFavKeys(dir), []);
});

test('the old window list is merged in once: the file first, then the old ones it lacks', () => {
  ST.writeFavKeys(dir, ['openai|gpt-5']);
  const res = ST.modelFavLoad(dir, ['local-llama|qwen3-8b', 'openai|gpt-5']);
  assert.deepEqual(res, { ok: true, keys: ['openai|gpt-5', 'local-llama|qwen3-8b'], saved: true });
  assert.deepEqual(fileOf(), { models: ['openai/gpt-5', 'local-llama/qwen3-8b'] });
  // Nothing old: the file as it is, not written.
  assert.deepEqual(ST.modelFavLoad(dir, []), { ok: true, keys: ['openai|gpt-5', 'local-llama|qwen3-8b'], saved: true });
  assert.deepEqual(ST.modelFavLoad(dir, 'nope').keys, ['openai|gpt-5', 'local-llama|qwen3-8b']);
});

test('a star reads the file again first, so one set in the terminal meanwhile is kept', () => {
  ST.writeFavKeys(dir, ['openai|gpt-5']);
  // The terminal adds one behind the window's back.
  writeFileSync(join(dir, ST.MODEL_FAVORITES_FILE), JSON.stringify({ models: ['openai/gpt-5', 'anthropic/claude-opus'] }));
  assert.deepEqual(ST.modelFavToggle(dir, 'openrouter|a/b'), { ok: true, keys: ['openai|gpt-5', 'anthropic|claude-opus', 'openrouter|a/b'], on: true });
  assert.deepEqual(ST.modelFavToggle(dir, 'openai|gpt-5'), { ok: true, keys: ['anthropic|claude-opus', 'openrouter|a/b'], on: false });
  assert.deepEqual(ST.modelFavToggle(dir, 'not a key').ok, false);
  assert.deepEqual(fileOf(), { models: ['anthropic/claude-opus', 'openrouter/a/b'] });
});

test('a full list drops its oldest, as the picker always did', () => {
  const full = Array.from({ length: ST.MODEL_FAVORITES_MAX }, (_, i) => 'openai|m' + i);
  const next = ST.toggleFavKey(full, 'openai|new');
  assert.equal(next.keys.length, ST.MODEL_FAVORITES_MAX);
  assert.equal(next.keys[0], 'openai|m1');
  assert.equal(next.keys.at(-1), 'openai|new');
});

test('main wires the routes on the agent state dir, and the preload exposes them', () => {
  const main = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
  assert.match(main, /import \{ wireModelFavoritesIpc \} from "\.\/model-favorites-ipc\.js";/);
  assert.match(main, /wireModelFavoritesIpc\(\{ stateDir: DESKTOP_STATE_DIR \}\);/);
  const pre = readFileSync(new URL('../preload/preload.ts', import.meta.url), 'utf8');
  assert.match(pre, /modelFavLoad: \(legacy\?: string\[\]\) => ipcRenderer\.invoke\("modelFav:load", legacy\)/);
  assert.match(pre, /modelFavToggle: \(key: string\) => ipcRenderer\.invoke\("modelFav:toggle", key\)/);
});
