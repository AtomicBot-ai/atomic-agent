// ATO-336: Settings › Models' Context size (Auto / 32K / 64K / 128K / the
// model's max, never above it) and Advanced's Parallel slots (Auto / 1 / 2 /
// 4), and the values they write to localModels.managed.contextSize (0 = auto)
// and localModels.managed.parallel ("auto" or 1..8, config v63).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {
  lcsParseContextLabel, lcsContextWord, lcsStoredContext, lcsStoredSlots,
  lcsContextOptions, lcsSlotOptions, lcsContextConfigValue, lcsSlotConfigValue, lcsSaidLine,
} = createRequire(import.meta.url)('../renderer/local-context-slots.js');

const values = (opts) => opts.map((o) => o.value);
const lit = (opts) => opts.filter((o) => o.on).map((o) => o.value);

test('the catalogue label reads as llama.cpp counts it', () => {
  assert.equal(lcsParseContextLabel('128K'), 131072);
  assert.equal(lcsParseContextLabel('256K'), 262144);
  assert.equal(lcsParseContextLabel('1M'), 1048576);
  assert.equal(lcsParseContextLabel('32768'), 32768);
  assert.equal(lcsParseContextLabel(' 64k '), 65536);
  for (const junk of ['—', '', null, undefined, '?', '0', 'abc', '-8K']) assert.equal(lcsParseContextLabel(junk), null, String(junk));
});

test('sizes are said in the list\'s words', () => {
  assert.equal(lcsContextWord(0), 'Auto');
  assert.equal(lcsContextWord(65536), '64K');
  assert.equal(lcsContextWord(1048576), '1M');
  assert.equal(lcsContextWord(40000), '39.1K');
  assert.equal(lcsContextWord(512), '512');
});

test('a 256K model offers Auto, 32K, 64K, 128K and its max', () => {
  const opts = lcsContextOptions(0, '256K');
  assert.deepEqual(values(opts), [0, 32768, 65536, 131072, 262144]);
  assert.deepEqual(opts.map((o) => o.label), ['Auto', '32K', '64K', '128K', 'Max 256K']);
  assert.deepEqual(lit(opts), [0]);
});

test('nothing above the model max is offered, and the max is not offered twice', () => {
  assert.deepEqual(values(lcsContextOptions(0, '128K')), [0, 32768, 65536, 131072]);
  assert.equal(lcsContextOptions(0, '128K').at(-1).label, 'Max 128K');
  assert.deepEqual(values(lcsContextOptions(0, '40K')), [0, 32768, 40960]);
  assert.deepEqual(values(lcsContextOptions(0, '8K')), [0, 8192]);
});

test('an unknown model max offers the fixed sizes and no Max', () => {
  for (const label of [null, undefined, '', '—']) {
    const opts = lcsContextOptions(0, label);
    assert.deepEqual(values(opts), [0, 32768, 65536, 131072], String(label));
    assert.ok(!opts.some((o) => o.label.startsWith('Max')));
  }
});

test('the stored size is the one lit; one set outside the app gets its own choice', () => {
  assert.deepEqual(lit(lcsContextOptions(65536, '256K')), [65536]);
  assert.deepEqual(lit(lcsContextOptions(262144, '256K')), [262144]);
  const odd = lcsContextOptions(40000, '256K');
  assert.deepEqual(values(odd), [0, 32768, 40000, 65536, 131072, 262144]);
  assert.deepEqual(lit(odd), [40000]);
  // A size pinned for a bigger model stays visible after a switch to a smaller one.
  assert.deepEqual(lit(lcsContextOptions(262144, '128K')), [262144]);
  // Missing or junk is Auto.
  for (const raw of [undefined, null, 'x', -1, 1.5]) assert.deepEqual(lit(lcsContextOptions(raw, '128K')), [0], String(raw));
});

test('slot choices are Auto, 1, 2, 4, with a stored pin of its own', () => {
  assert.deepEqual(values(lcsSlotOptions('auto')), ['auto', 1, 2, 4]);
  assert.deepEqual(lit(lcsSlotOptions('auto')), ['auto']);
  assert.deepEqual(lit(lcsSlotOptions(undefined)), ['auto']);
  assert.deepEqual(lit(lcsSlotOptions(2)), [2]);
  assert.deepEqual(values(lcsSlotOptions(6)), ['auto', 1, 2, 4, 6]);
  assert.deepEqual(lit(lcsSlotOptions(6)), [6]);
  // Out of the schema's 1..8 is not a pin the agent would keep: Auto.
  assert.deepEqual(lit(lcsSlotOptions(12)), ['auto']);
  assert.equal(lcsStoredSlots('3'), 3);
});

test('the written values are what `config set` takes', () => {
  // 64K + 2 slots: contextSize 65536, parallel 2 (the live check in the PR).
  assert.equal(lcsContextConfigValue(65536), '65536');
  assert.equal(lcsContextConfigValue('65536'), '65536');
  assert.equal(lcsSlotConfigValue('2'), '2');
  // Back to Auto: contextSize 0, parallel "auto".
  assert.equal(lcsContextConfigValue('0'), '0');
  assert.equal(lcsSlotConfigValue('auto'), 'auto');
  assert.equal(lcsSlotConfigValue('AUTO'), 'auto');
  for (const bad of ['', 'auto', '-1', '1.5', 'x', String(1 << 30)]) assert.equal(lcsContextConfigValue(bad), null, bad);
  for (const bad of ['', '0', '9', '-2', '1.5', 'x']) assert.equal(lcsSlotConfigValue(bad), null, bad);
});

test('the stored context reads 0 for Auto and junk', () => {
  assert.equal(lcsStoredContext(0), 0);
  assert.equal(lcsStoredContext(undefined), 0);
  assert.equal(lcsStoredContext(131072), 131072);
});

test('the line after a write says whether the server restarted', () => {
  assert.equal(lcsSaidLine('ctx', '65536', true), 'Context size: 64K. The model server restarted with it.');
  assert.equal(lcsSaidLine('ctx', '0', false), 'Context size: Auto. It applies the next time the model server starts.');
  assert.equal(lcsSaidLine('slots', 'auto', false), 'Parallel slots: Auto. It applies the next time the model server starts.');
  assert.equal(lcsSaidLine('slots', '2', true), 'Parallel slots: 2. The model server restarted with it.');
});
