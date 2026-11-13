// ATO-490: the composer's reasoning depth chip (renderer/reasoning-switch.js)
// and the level on its way to the agent (main/reasoning-level.ts, built output).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
  REASONING_LEVELS, REASONING_STORE_MAX, reasoningLevel, reasoningNext, reasoningSupported, reasoningForTurn, reasoningTip,
  reasoningMapRead, reasoningMapSet,
} = require('../renderer/reasoning-switch.js');
const { reasoningLevelFromWindow, reasoningBodyField } = require('../out/main/reasoning-level.js');

const effort = {reasoning: {control: 'effort', levels: ['auto', 'low', 'medium', 'high']}};
const budget = {reasoning: {control: 'budget', levels: ['auto', 'low', 'medium', 'high']}};
const none = {reasoning: {control: 'none', levels: ['auto']}};

test('the chip cycles Auto, Low, Medium, High and back', () => {
  assert.deepEqual(REASONING_LEVELS, ['auto', 'low', 'medium', 'high']);
  assert.equal(reasoningNext('auto'), 'low');
  assert.equal(reasoningNext('low'), 'medium');
  assert.equal(reasoningNext('medium'), 'high');
  assert.equal(reasoningNext('high'), 'auto');
  assert.equal(reasoningNext('weird'), 'low');
  assert.equal(reasoningLevel('xhigh'), 'auto');
});

test('the chip shows only where the agent says the model takes a level', () => {
  assert.equal(reasoningSupported(effort), true);
  assert.equal(reasoningSupported(budget), true);
  assert.equal(reasoningSupported(none), false);
  // An agent from before the field, or no capabilities yet.
  assert.equal(reasoningSupported({}), false);
  assert.equal(reasoningSupported(null), false);
});

test('a turn sends the level only when it is not Auto and the route takes one', () => {
  assert.equal(reasoningForTurn('high', effort), 'high');
  assert.equal(reasoningForTurn('low', budget), 'low');
  assert.equal(reasoningForTurn('auto', effort), undefined);
  assert.equal(reasoningForTurn('high', none), undefined);
  assert.equal(reasoningForTurn('high', null), undefined);
});

test('the tooltip says what the level does on a cloud and on a local model', () => {
  assert.match(reasoningTip('medium', effort), /^Reasoning: Medium\. .*medium reasoning effort/);
  assert.match(reasoningTip('low', budget), /short thinking budget/);
  assert.match(reasoningTip('high', budget), /no limit on thinking/);
  assert.match(reasoningTip('auto', effort), /model’s settings/);
  assert.doesNotMatch(reasoningTip('auto', effort), /—/);
});

test('the per-chat store keeps levels, drops Auto and junk, and forgets the oldest past its cap', () => {
  assert.deepEqual(reasoningMapRead('{"a":"high","b":"auto","c":"xhigh","d":"low"}'), {a: 'high', d: 'low'});
  assert.deepEqual(reasoningMapRead('not json'), {});
  assert.deepEqual(reasoningMapRead('[1,2]'), {});
  assert.deepEqual(reasoningMapRead(null), {});
  let map = reasoningMapSet({}, 'a', 'high');
  map = reasoningMapSet(map, 'b', 'low');
  assert.deepEqual(map, {a: 'high', b: 'low'});
  // Back to Auto removes the chat's entry.
  assert.deepEqual(reasoningMapSet(map, 'a', 'auto'), {b: 'low'});
  // A changed chat moves to the newest end.
  assert.deepEqual(Object.keys(reasoningMapSet(map, 'a', 'medium')), ['b', 'a']);
  let big = {};
  for (let i = 0; i < REASONING_STORE_MAX + 3; i++) big = reasoningMapSet(big, 's' + i, 'low');
  assert.equal(Object.keys(big).length, REASONING_STORE_MAX);
  assert.equal(big.s0, undefined);
  assert.equal(big['s' + (REASONING_STORE_MAX + 2)], 'low');
});

test('main passes only low, medium and high to the agent, as reasoning_effort', () => {
  assert.equal(reasoningLevelFromWindow('high'), 'high');
  for (const v of ['auto', 'HIGH', 'xhigh', '', null, undefined, 1]) assert.equal(reasoningLevelFromWindow(v), undefined);
  assert.deepEqual(reasoningBodyField('low'), {reasoning_effort: 'low'});
  assert.deepEqual(reasoningBodyField(undefined), {});
});

test('the window loads the chip before renderer.js, and renderer.js wires it in', () => {
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = html.indexOf('<script src="reasoning-switch.js"></script>');
  assert.ok(at > 0);
  assert.ok(at < html.indexOf('<script src="renderer.js"></script>'));
  const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(renderer, /\+ modelChipHtml\(\)\n\s*\+ reasoningChipHtml\(\)/);
  assert.match(renderer, /BR\.chat\(\[\{role:'user', content:text\}\], session, reasoningTurnLevel\(session\)\)/);
  assert.match(renderer, /reasoningAdoptDraft\(S\.agentSession\)/);
});
