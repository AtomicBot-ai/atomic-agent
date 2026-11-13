// ATO-1087: Settings › Privacy › Offline mode (renderer/offline-mode.js)
// and its transport (AgentClient.offlineMode, built output).
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {OFFLINE_OLD_AGENT, OFFLINE_NO_COUNTER, offlineEgress, offlineBytes, offlineEgressLine,
  createOfflineMode, offlineModeHTML} = require('../renderer/offline-mode.js');
const { AgentClient } = require('../out/main/agent-client.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const SINCE = '2026-11-12T10:00:00.000Z';
const egress = (over = {}) => Object.assign({bytesOut: 0, requestsOut: 0, requestsBlocked: 0, since: SINCE}, over);
const ok = (enabled, e = egress()) => ({supported: true, ok: true, data: {enabled, egress: e}});

function fakeApi(reads, sets = []) {
  const calls = [];
  return {calls, read: async () => { calls.push('read'); return reads.shift(); },
    set: async (on) => { calls.push({set: on}); return sets.shift(); }};
}

test('the counter is taken as the agent sent it, or not at all', () => {
  assert.deepEqual(offlineEgress(egress({bytesOut: 10.9})), egress({bytesOut: 10}));
  assert.equal(offlineEgress(null), null);
  assert.equal(offlineEgress(egress({bytesOut: undefined})), null);
  assert.equal(offlineEgress(egress({requestsBlocked: -2})), null);
  assert.equal(offlineEgress(egress({since: 'yesterday-ish'})), null);
});

test('bytes and the line read plainly', () => {
  assert.equal(offlineBytes(0), '0 bytes');
  assert.equal(offlineBytes(1), '1 byte');
  assert.equal(offlineBytes(1536), '1.5 KB');
  assert.equal(offlineBytes(20 * 1024 * 1024), '20 MB');
  assert.match(offlineEgressLine(egress({requestsBlocked: 3})), /^0 bytes sent out since \d\d:\d\d · 3 requests blocked$/);
  assert.match(offlineEgressLine(egress({bytesOut: 2048, requestsBlocked: 1})), /^2 KB sent out since \d\d:\d\d · 1 request blocked$/);
  assert.doesNotMatch(offlineEgressLine(egress({bytesOut: 5})), /blocked/);
  assert.equal(offlineEgressLine(null), null);
});

test('an agent without the route: the switch is disabled and says why', async () => {
  const om = createOfflineMode(fakeApi([{supported: false}]));
  await om.load();
  assert.equal(om.state.supported, false);
  const html = offlineModeHTML(om.state, {esc});
  assert.match(html, /Offline mode/);
  assert.ok(html.includes(esc(OFFLINE_OLD_AGENT)));
  assert.match(html, /data-act="offline:toggle" disabled/);
  assert.doesNotMatch(html, /sent out/);
  assert.deepEqual(await om.toggle(), {ok: false});
});

test('the line is the agent\'s number, not a fixed zero', async () => {
  const om = createOfflineMode(fakeApi([ok(false, egress({bytesOut: 4096, requestsOut: 2}))]));
  await om.load();
  const html = offlineModeHTML(om.state, {esc});
  assert.match(html, /4 KB sent out since/);
  assert.doesNotMatch(html, /0 bytes/);
  assert.doesNotMatch(html, / disabled/);
  assert.match(html, /aria-checked="false"/);
});

test('a missing counter says so instead of showing zero', async () => {
  const om = createOfflineMode(fakeApi([ok(true, undefined)]));
  await om.load();
  const html = offlineModeHTML(om.state, {esc});
  assert.ok(html.includes(esc(OFFLINE_NO_COUNTER)));
  assert.doesNotMatch(html, /sent out since/);
  assert.match(html, /aria-checked="true"/);
});

test('toggle asks the agent and shows what it answered', async () => {
  const api = fakeApi([ok(false, egress({bytesOut: 900}))], [ok(true, egress({requestsBlocked: 0}))]);
  const om = createOfflineMode(api);
  await om.load();
  assert.deepEqual(await om.toggle(), {ok: true, enabled: true});
  assert.deepEqual(api.calls, ['read', {set: true}]);
  assert.equal(om.state.enabled, true);
  assert.match(offlineModeHTML(om.state, {esc}), /0 bytes sent out since/);
});

test('a failed switch keeps the old state and offers a retry', async () => {
  const om = createOfflineMode(fakeApi([ok(false)], [{supported: true, ok: false, error: 'config is read-only'}]));
  await om.load();
  assert.deepEqual(await om.toggle(), {ok: false});
  assert.equal(om.state.enabled, false);
  assert.equal(om.state.error, 'Couldn’t switch offline mode: config is read-only');
  assert.match(offlineModeHTML(om.state, {esc}), /data-act="offline:reload"/);
});

test('a read that lands after a switch does not undo it', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const reads = [ok(false), slow];
  const om = createOfflineMode({read: () => reads.shift(), set: async () => ok(true)});
  await om.load();
  const late = om.load();
  await om.toggle();
  release(ok(false));
  await late;
  assert.equal(om.state.enabled, true);
});

test('reset forgets the last agent', async () => {
  const om = createOfflineMode(fakeApi([{supported: false}]));
  await om.load();
  om.reset();
  assert.equal(om.state.supported, null);
  assert.equal(om.state.enabled, null);
});

/** An agent stand-in for the client half. */
async function standIn(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({method: req.method, url: req.url, body});
      const [code, json] = answer(req, body);
      res.writeHead(code, {'content-type': 'application/json'});
      res.end(typeof json === 'string' ? json : JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new AgentClient(process.cwd());
  client.port = server.address().port;
  client.token = 't0ken';
  return {client, seen, close: () => new Promise((resolve) => server.close(resolve))};
}

test('client: read, switch, a bad body, and an agent from before the route', async () => {
  let enabled = false;
  const s = await standIn((req, body) => {
    if (req.method === 'POST') enabled = JSON.parse(body).enabled;
    return [200, {enabled, egress: egress({requestsBlocked: enabled ? 1 : 0})}];
  });
  try {
    const got = await s.client.offlineMode();
    assert.deepEqual(got, {supported: true, ok: true, data: {enabled: false, egress: egress()}});
    assert.equal(s.seen[0].method, 'GET');
    assert.equal(s.seen[0].url, '/api/offline-mode');
    const set = await s.client.offlineMode(true);
    assert.equal(set.ok, true);
    assert.equal(set.data.enabled, true);
    assert.equal(s.seen[1].method, 'POST');
    assert.deepEqual(JSON.parse(s.seen[1].body), {enabled: true});
  } finally { await s.close(); }
  const bad = await standIn(() => [200, {egress: egress()}]);
  try {
    const got = await bad.client.offlineMode();
    assert.equal(got.ok, false);
    assert.equal(got.supported, true);
  } finally { await bad.close(); }
  const old = await standIn(() => [404, {error: {message: 'No route for GET /api/offline-mode'}}]);
  try {
    assert.deepEqual(await old.client.offlineMode(), {supported: false});
    assert.deepEqual(await old.client.offlineMode(true), {supported: false});
  } finally { await old.close(); }
});
