// ATO-2455: Settings › Models › Advanced's Experts on CPU (Auto / Off / 8 /
// 16 / 32 layers) and the value it writes to localModels.managed.cpuMoe,
// and the Local models badge "Fits, experts in RAM".
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {cmoeStored, cmoeOptions, cmoeConfigValue, cmoeSaidLine, cmoeFitBadge} =
  createRequire(import.meta.url)('../renderer/local-cpu-moe.js');

const values = (opts) => opts.map((o) => o.value);
const lit = (opts) => opts.filter((o) => o.on).map((o) => o.value);

test('the stored value reads as the agent takes it', () => {
  assert.equal(cmoeStored('off'), 'off');
  assert.equal(cmoeStored(16), 16);
  assert.equal(cmoeStored('24'), 24);
  for (const raw of [undefined, null, '', 'auto', 'x', 0, -1, 1.5, 513]) assert.equal(cmoeStored(raw), 'auto', String(raw));
});

test('Auto, Off and three counts; a pin from the terminal gets its own choice', () => {
  assert.deepEqual(values(cmoeOptions('auto', false)), ['auto', 'off', 8, 16, 32]);
  assert.deepEqual(lit(cmoeOptions(undefined, false)), ['auto']);
  assert.deepEqual(lit(cmoeOptions('off', false)), ['off']);
  assert.deepEqual(values(cmoeOptions(24, false)), ['auto', 'off', 8, 16, 24, 32]);
  assert.deepEqual(lit(cmoeOptions(24, false)), [24]);
  assert.match(cmoeOptions('auto', true)[0].tip, /Mac/);
});

test('only what the agent accepts is written', () => {
  assert.equal(cmoeConfigValue('auto'), 'auto');
  assert.equal(cmoeConfigValue('off'), 'off');
  assert.equal(cmoeConfigValue(16), '16');
  for (const junk of ['0', '513', '-4', 'abc', '', null, undefined, '1.5']) assert.equal(cmoeConfigValue(junk), null, String(junk));
});

test('says what was set and whether the server restarted', () => {
  assert.equal(cmoeSaidLine('auto', true), 'Experts on CPU: Auto. The model server restarted with it.');
  assert.equal(cmoeSaidLine('16', false), 'Experts on CPU: 16 layers. It applies the next time the model server starts.');
});

test('the badge: over a tight fit only, when the agent says it fits, unless off', () => {
  const tight = {v: 'tight'};
  const row = {id: 'qwen-3.6-35b-a3b', expertsInRam: {tier: 'fits', speed: '~10 tok/s, estimate'}};
  const b = cmoeFitBadge(row, tight, 'auto');
  assert.equal(b.word, 'Fits, experts in RAM');
  assert.equal(b.tone, 'green');
  assert.match(b.title, /~10 tok\/s, estimate/);
  assert.equal(cmoeFitBadge(row, tight, 'off'), null);
  assert.equal(cmoeFitBadge(row, {v: 'over'}, 'auto'), null);
  assert.equal(cmoeFitBadge(row, {v: 'comfortable'}, 'auto'), null);
  assert.equal(cmoeFitBadge({id: 'x'}, tight, 'auto'), null);
  assert.equal(cmoeFitBadge({...row, expertsInRam: {tier: 'tight', speed: null}}, tight, 'auto'), null);
});

test('no long dash in what a person reads', () => {
  const words = cmoeOptions('auto', false).map((o) => o.label + o.tip).join(' ') + cmoeSaidLine('off', true);
  assert.doesNotMatch(words, /\u2014/);
});
