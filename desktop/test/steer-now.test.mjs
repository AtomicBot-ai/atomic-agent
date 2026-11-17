// ATO-1183: "Steer now" on a queued message above the composer (renderer/steer-now.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const N = require('../renderer/steer-now.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const fresh = () => ({refused: []});
const ctx = (over) => Object.assign({running: true, sid: 's1', canSteer: true, refused: []}, over);

test('a 409 refuses for this turn; a full inbox, a failed round trip and an accept do not', () => {
  assert.equal(N.steerNowRefusedForTurn({ok: false, steered: false,
    error: 'session s1 has no turn accepting steers — send the message with POST /v1/chat/completions instead'}), true);
  assert.equal(N.steerNowRefusedForTurn({ok: true, steered: false}), true);
  assert.equal(N.steerNowRefusedForTurn({ok: false, steered: false,
    error: 'steering inbox for session s1 is full — the running turn has not consumed the pending messages yet'}), false);
  assert.equal(N.steerNowRefusedForTurn({ok: false, steered: false, error: 'fetch failed'}), false);
  assert.equal(N.steerNowRefusedForTurn(null), false);
  assert.equal(N.steerNowRefusedForTurn({ok: true, steered: true}), false);
});

test('the button shows only while this chat runs a turn with a session to ask and a steer bridge', () => {
  assert.equal(N.steerNowAvailable('hi', ctx()), true);
  assert.equal(N.steerNowAvailable('hi', ctx({running: false})), false);
  assert.equal(N.steerNowAvailable('hi', ctx({sid: null})), false, 'a new chat whose turn has not reported its session');
  assert.equal(N.steerNowAvailable('hi', ctx({canSteer: false})), false, 'an older preload without BR.steer');
});

test('no loop: a message the turn refused (409) loses the button until a turn ends', () => {
  const st = fresh();
  N.steerNowNoteRefusal('do X', {ok: false, error: 'session s1 has no turn accepting steers'}, st);
  assert.equal(N.steerNowAvailable('do X', ctx({refused: st.refused})), false);
  assert.equal(N.steerNowAvailable('do Y', ctx({refused: st.refused})), true, 'other messages keep theirs');
  N.steerNowTurnEnded(st);
  assert.equal(N.steerNowAvailable('do X', ctx({refused: st.refused})), true);
});

test('a full inbox keeps the button: the turn reads its inbox as it goes', () => {
  const st = fresh();
  N.steerNowNoteRefusal('do X', {ok: false, error: 'steering inbox for session s1 is full'}, st);
  assert.deepEqual(st.refused, []);
  assert.equal(N.steerNowAvailable('do X', ctx({refused: st.refused})), true);
});

test('taking a message out keeps the STEER.ahead watermark right, as unqueueMessage does', () => {
  // Two refused steers parked ahead, then ordinary backlog.
  let q = ['steer a', 'steer b', 'backlog c', 'backlog d'];
  assert.equal(N.steerNowTake(q, 0, 2), 1);
  assert.deepEqual(q, ['steer b', 'backlog c', 'backlog d']);
  q = ['steer a', 'steer b', 'backlog c', 'backlog d'];
  assert.equal(N.steerNowTake(q, 2, 2), 2);
  assert.deepEqual(q, ['steer a', 'steer b', 'backlog d']);
  q = ['a'];
  assert.equal(N.steerNowTake(q, 5, 0), 0, 'out of range changes nothing');
  assert.equal(N.steerNowTake(q, -1, 0), 0);
  assert.deepEqual(q, ['a']);
});

test('the button names its chip and says what it does', () => {
  const html = N.steerNowButtonHTML(3, {esc});
  assert.match(html, /data-steernow="3"/);
  assert.match(html, />Steer now</);
  assert.match(html, /aria-label="Steer now"/);
});

test('wiring: loaded before renderer.js, drawn on the chip, refusals noted, cleared at a turn end', () => {
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('src="steer-now.js"') > 0 && html.indexOf('src="steer-now.js"') < html.indexOf('src="renderer.js"'));
  const r = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(r, /steerNowShown\(t\) \? steerNowButtonHTML\(i, \{esc\}\)/);
  assert.match(r, /if \(!steered\) steerNowNoteRefusal\(text, res\);/);
  assert.match(r, /STEER\.mine\.length = 0;\n\s*steerNowTurnEnded\(\);/);
  assert.match(r, /closest\('\[data-steernow\]'\)[^\n]*steerQueuedNow\(\+sn\.dataset\.steernow\)/);
  // Steer now goes the typed-under-a-turn way, not a new turn of its own.
  const fn = r.slice(r.indexOf('function steerQueuedNow('), r.indexOf('function unqueueMessage('));
  assert.match(fn, /steerNowTake\(S\.queued, at, STEER\.ahead\)/);
  assert.match(fn, /steerOrQueue\(text, \{sid:S\.agentSession, key:queueKey\(\)/);
  assert.doesNotMatch(fn, /attForgetMessage/, 'the files of a message that still goes stay');
});
