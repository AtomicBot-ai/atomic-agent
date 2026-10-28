import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('../renderer/memory-model-card.js');

// ATO-900 item 5: a click on the memory model says what it did on its own card.

const base = {downloaded: true, pulling: false, picked: true, enabled: true, running: true, health: 'ok', busy: false, error: null, engine: null, chatUp: true};
const card = (patch) => R.memCardState(Object.assign({}, base, patch));

test('while the click runs the card says Starting… with a spinner, picked or not', () => {
  for (const picked of [true, false]) {
    const s = card({busy: true, picked, running: false});
    assert.equal(s.key, 'starting');
    assert.equal(s.word, 'Starting…');
    assert.equal(s.spin, true);
    assert.equal(s.selected, picked);
    assert.equal(s.act, null);
  }
});

test('the model memory search uses with its server answering is Running and selected', () => {
  const s = card({});
  assert.equal(s.key, 'running');
  assert.equal(s.word, 'Running');
  assert.equal(s.tone, 'green');
  assert.equal(s.selected, true);
  assert.equal(s.spin, false);
});

test('a server still loading reads Starting…, not a failure', () => {
  for (const health of ['loading', 'starting', '']) assert.equal(card({health}).key, 'starting');
});

test('a failed click shows Failed with the reason and Retry, on the card', () => {
  const s = card({picked: false, running: false, error: 'Couldn’t start the memory model: port 19192 is busy'});
  assert.equal(s.key, 'failed');
  assert.equal(s.tone, 'red');
  assert.match(s.line, /port 19192 is busy/);
  assert.equal(s.act, 'llm:embRetry');
  assert.equal(s.label, 'Retry');
});

test('a server that answers since the failure wins over it', () => {
  assert.equal(card({error: 'Couldn’t start the memory model.'}).key, 'running');
});

test('a missing engine says so with its one fix, Download again; none when it cannot be retried', () => {
  const engine = {why: 'The Atomic Chat engine could not be downloaded.', retryable: true};
  const failed = card({running: false, error: 'x', engine});
  assert.equal(failed.key, 'engine');
  assert.equal(failed.line, engine.why);
  assert.equal(failed.act, 'engf:retry');
  assert.equal(failed.label, 'Download again');
  const stopped = card({running: false, engine});
  assert.equal(stopped.key, 'engine');
  const fixed = card({running: false, engine: {why: 'Blocked by the system.', retryable: false}});
  assert.equal(fixed.act, null);
  assert.equal(fixed.label, null);
});

test('picked but its file is gone, local memory search off, or its server down: each says so, selected', () => {
  const missing = card({downloaded: false, running: false});
  assert.equal(missing.key, 'missing');
  assert.equal(missing.word, 'Not downloaded');
  const off = card({enabled: false, running: false});
  assert.equal(off.key, 'off');
  assert.match(off.line, /by keyword/);
  const down = card({running: false, chatUp: false});
  assert.equal(down.key, 'stopped');
  assert.equal(down.word, 'Not running');
  assert.match(down.line, /starts with the local model server/);
  assert.match(card({running: false, chatUp: true}).line, /Start it/);
  for (const s of [missing, off, down]) assert.equal(s.selected, true);
});

test('a server up that does not answer is Not answering, not Running', () => {
  const s = card({health: 'unreachable'});
  assert.equal(s.key, 'stalled');
  assert.equal(s.word, 'Not answering');
});

test('a card nobody picked, or one coming down, adds nothing to its pill', () => {
  assert.equal(card({picked: false}), null);
  assert.equal(card({pulling: true, busy: true}), null);
});

test('no new string carries an em dash', () => {
  const states = [card({busy: true}), card({}), card({error: 'e', running: false, picked: false}), card({downloaded: false}),
    card({enabled: false}), card({running: false}), card({running: false, chatUp: false}), card({health: 'down'}),
    card({running: false, engine: {why: 'w'}})];
  for (const s of states) assert.doesNotMatch(s.word + ' ' + s.line + ' ' + (s.label || ''), /\u2014/);
});

test('the failure sentence keeps what the agent said, without its prefix', () => {
  assert.equal(R.memCardError({ok: false, error: 'Error: port busy'}), 'Couldn’t start the memory model: port busy');
  assert.equal(R.memCardError({ok: false, stderr: 'line one\nno model file'}), 'Couldn’t start the memory model: no model file');
  assert.equal(R.memCardError(null, 'boom'), 'Couldn’t start the memory model: boom');
  assert.equal(R.memCardError(null), 'Couldn’t start the memory model.');
});
