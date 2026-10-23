// Unit tests for main/telegram-pairing.ts (ATO-859), against the built
// output. Run: npm run build && npm run test:unit
//
// How the agent's /api/telegram/pairing answers are read for the renderer:
// the request per op, a 404 from an agent without the route as
// `unsupported`, the agent's error code passed through, a body that is not
// JSON as an error. No network: the reader takes a status and a body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../out/main/telegram-pairing.js');

test('the request per op: POST carries replaceOwner, GET and DELETE carry nothing', () => {
  assert.deepEqual(T.pairingRequest('start', false), {method:'POST', body:{replaceOwner:false}});
  assert.deepEqual(T.pairingRequest('start', true), {method:'POST', body:{replaceOwner:true}});
  assert.deepEqual(T.pairingRequest('status', true), {method:'GET'});
  assert.deepEqual(T.pairingRequest('cancel', true), {method:'DELETE'});
  assert.equal(T.TELEGRAM_PAIRING_PATH, '/api/telegram/pairing');
  for (const op of ['start', 'status', 'cancel']) assert.equal(T.isTelegramPairingOp(op), true);
  for (const op of ['pair', '', null, undefined, 1]) assert.equal(T.isTelegramPairingOp(op), false);
});

test('a 404 is an agent without the route', () => {
  const r = T.readPairingReply(404, JSON.stringify({error:{message:'No route for POST /api/telegram/pairing'}}));
  assert.equal(r.ok, false);
  assert.equal(r.unsupported, true);
});

test('a 200 hands the body through', () => {
  const body = {status:'waiting', code:'048213', expiresAt:1, timeoutMs:300000, botUsername:'b', instruction:'x'};
  assert.deepEqual(T.readPairingReply(200, JSON.stringify(body)), {ok:true, data:body});
  assert.equal(T.readPairingReply(200, 'not json').ok, false);
  assert.equal(T.readPairingReply(200, '').ok, false);
});

test('an error keeps the agent\'s message and code', () => {
  const owner = T.readPairingReply(409, JSON.stringify({error:{message:'This bot already has an owner.', type:'invalid_request_error', param:'replaceOwner', code:'owner_already_paired'}}));
  assert.deepEqual(owner, {ok:false, error:'This bot already has an owner.', code:'owner_already_paired'});
  const down = T.readPairingReply(409, JSON.stringify({error:{message:'Telegram is not running (state: down).', code:'telegram_not_running'}}));
  assert.equal(down.code, 'telegram_not_running');
  assert.deepEqual(T.readPairingReply(401, ''), {ok:false, error:'HTTP 401'});
  assert.deepEqual(T.readPairingReply(503, JSON.stringify({error:{message:'Telegram is not available in this agent', code:'telegram_unavailable'}})),
    {ok:false, error:'Telegram is not available in this agent', code:'telegram_unavailable'});
});
