import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { starterVerdict, STARTER_MODEL_ID } = require('../out/main/starter-model.js');
const { curatedMetaIds } = require('../out/main/model-catalog.js');

/** ATO-1041: the first launch with nothing to answer on fetches the starter model; anyone set up is left alone. */
const list = (downloaded) => [{ id: 'qwen-3.5-4b', downloaded }, { id: STARTER_MODEL_ID, downloaded: false }];

test('nothing on disk and no cloud key: fetch it', () => {
  assert.deepEqual(starterVerdict({ chatModels: list(false), cloudReady: false }), { fetch: true });
});

test('a model on disk, a cloud key, or an unreadable list: leave it', () => {
  assert.equal(starterVerdict({ chatModels: list(true), cloudReady: false }).fetch, false);
  assert.equal(starterVerdict({ chatModels: list(false), cloudReady: true }).fetch, false);
  assert.equal(starterVerdict({ chatModels: null, cloudReady: false }).fetch, false);
});

test('an agent whose catalog has no starter: nothing to fetch', () => {
  assert.deepEqual(starterVerdict({ chatModels: [{ id: 'qwen-3.5-4b', downloaded: false }], cloudReady: false }), { fetch: false, why: 'not_in_catalog' });
});

test('the vendored catalog knows the starter', () => {
  assert.ok(curatedMetaIds().includes(STARTER_MODEL_ID));
});
