import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { convStep, convTakeVerdict, CONV_QUIET_MS, CONV_NOTHING_MS } = require('../renderer/converse.js');

/** ATO-1047: listen → send → read the reply → listen again, as a table. */
test('the loop goes round: listen, send, speak, listen', () => {
  assert.deepEqual(convStep('off', 'toggle'), { state: 'listening', effect: 'listen' });
  assert.deepEqual(convStep('listening', { type: 'heard', text: 'what time is it' }), { state: 'thinking', effect: 'send' });
  assert.deepEqual(convStep('thinking', { type: 'reply', text: 'It is noon.' }), { state: 'speaking', effect: 'speak' });
  assert.deepEqual(convStep('speaking', 'spoken'), { state: 'listening', effect: 'listen' });
});

test('a take with no words ends the loop; an empty reply listens again', () => {
  assert.deepEqual(convStep('listening', { type: 'heard', text: '   ' }), { state: 'off', effect: 'halt' });
  assert.deepEqual(convStep('thinking', { type: 'reply', text: '' }), { state: 'listening', effect: 'listen' });
});

test('any user action, the toggle and a failure stop it from every step; Escape discards', () => {
  for (const s of ['listening', 'thinking', 'speaking']) {
    assert.deepEqual(convStep(s, 'user'), { state: 'off', effect: 'halt' });
    assert.deepEqual(convStep(s, 'toggle'), { state: 'off', effect: 'halt' });
    assert.deepEqual(convStep(s, 'fail'), { state: 'off', effect: 'halt' });
    assert.deepEqual(convStep(s, 'escape'), { state: 'off', effect: 'discard' });
  }
  assert.deepEqual(convStep('off', 'escape'), { state: 'off', effect: null });
  assert.deepEqual(convStep('off', 'user'), { state: 'off', effect: null });
});

test('events that belong to another step change nothing', () => {
  assert.deepEqual(convStep('off', { type: 'reply', text: 'late' }), { state: 'off', effect: null });
  assert.deepEqual(convStep('listening', { type: 'reply', text: 'x' }), { state: 'listening', effect: null });
  assert.deepEqual(convStep('thinking', 'spoken'), { state: 'thinking', effect: null });
  assert.deepEqual(convStep('speaking', { type: 'heard', text: 'x' }), { state: 'speaking', effect: null });
});

test('a take ends after quiet that follows words, or after a long silence with none', () => {
  const t = { startedAt: 0, words: '', changedAt: 0, loudAt: 0 };
  assert.equal(convTakeVerdict(t, CONV_NOTHING_MS - 1), 'wait');
  assert.equal(convTakeVerdict(t, CONV_NOTHING_MS), 'nothing');
  const said = { startedAt: 0, words: 'hello there', changedAt: 1000, loudAt: 2000 };
  assert.equal(convTakeVerdict(said, 2000 + CONV_QUIET_MS - 1), 'wait');   // still loud recently
  assert.equal(convTakeVerdict(said, 2000 + CONV_QUIET_MS), 'send');
  assert.equal(convTakeVerdict({ ...said, changedAt: 5000 }, 2000 + CONV_QUIET_MS), 'wait');   // words still arriving
  assert.equal(convTakeVerdict({ ...said, startedAt: -CONV_NOTHING_MS }, 2000 + CONV_QUIET_MS), 'send');
});
