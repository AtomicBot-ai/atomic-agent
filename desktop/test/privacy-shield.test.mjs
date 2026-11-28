// ATO-1082: Settings › Privacy › Privacy Shield (renderer/privacy-shield.js)
// and its transport (AgentClient.privacyShield, built output).
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// ATO-2744: the renderer loads human-error.js first; its functions are globals there.
Object.assign(globalThis, require('../renderer/human-error.js'));
const {SHIELD_OLD_AGENT, SHIELD_NO_COUNTER, shieldCounterLine, createPrivacyShield, privacyShieldHTML} =
  require('../renderer/privacy-shield.js');
const { AgentClient } = require('../out/main/agent-client.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const ok = (enabled, masked = 0) => ({supported: true, ok: true, data: {enabled, masked}});

function fakeApi(reads, sets = []) {
  const calls = [];
  return {calls, read: async () => { calls.push('read'); return reads.shift(); },
    set: async (on) => { calls.push({set: on}); return sets.shift(); }};
}

test('the counter line reads plainly', () => {
  assert.equal(shieldCounterLine(0), 'Masked 0 values before they went to a cloud model, since the agent started.');
  assert.equal(shieldCounterLine(1), 'Masked 1 value before they went to a cloud model, since the agent started.');
  assert.equal(shieldCounterLine(null), null);
});

test('an agent without the route: the switch is disabled and says why', async () => {
  const shield = createPrivacyShield(fakeApi([{supported: false}]));
  await shield.load();
  assert.equal(shield.state.supported, false);
  const html = privacyShieldHTML(shield.state, {esc});
  assert.match(html, /Privacy Shield/);
  assert.ok(html.includes(esc(SHIELD_OLD_AGENT)));
  assert.match(html, / disabled/);
});

test('on, with the agent\'s own counter', async () => {
  const shield = createPrivacyShield(fakeApi([ok(true, 7)]));
  await shield.load();
  const html = privacyShieldHTML(shield.state, {esc});
  assert.match(html, /Masked 7 values/);
  assert.match(html, /aria-checked="true"/);
  assert.doesNotMatch(html, / disabled/);
});

test('a missing counter says so instead of showing zero', async () => {
  const shield = createPrivacyShield(fakeApi([{supported: true, ok: true, data: {enabled: false, masked: 'many'}}]));
  await shield.load();
  const html = privacyShieldHTML(shield.state, {esc});
  assert.ok(html.includes(esc(SHIELD_NO_COUNTER)));
  assert.doesNotMatch(html, /Masked 0/);
});

test('toggle asks the agent and shows what it answered', async () => {
  const api = fakeApi([ok(false, 2)], [ok(true, 2)]);
  const shield = createPrivacyShield(api);
  await shield.load();
  assert.deepEqual(await shield.toggle(), {ok: true, enabled: true});
  assert.deepEqual(api.calls, ['read', {set: true}]);
  assert.equal(shield.state.enabled, true);
});

test('a failed switch keeps the old state and offers a retry', async () => {
  const shield = createPrivacyShield(fakeApi([ok(false)], [{supported: true, ok: false, error: 'config is read-only'}]));
  await shield.load();
  assert.deepEqual(await shield.toggle(), {ok: false});
  assert.equal(shield.state.enabled, false);
  // ATO-2744: a sentence; the agent's words only under Details.
  assert.deepEqual(shield.state.error, {text: "Couldn't switch Privacy Shield. Try again.", detail: 'config is read-only'});
  const html = privacyShieldHTML(shield.state, {esc});
  assert.match(html, /data-act="shield:reload"/);
  assert.match(html, /<span class="herr-t">Couldn&#39;t switch Privacy Shield\. Try again\.<\/span><details class="herr-det"><summary>Details<\/summary><pre class="herr-raw">config is read-only<\/pre>/);
});

test('a read that lands after a switch does not undo it', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const reads = [ok(false), slow];
  const shield = createPrivacyShield({read: () => reads.shift(), set: async () => ok(true)});
  await shield.load();
  const late = shield.load();
  await shield.toggle();
  release(ok(false));
  await late;
  assert.equal(shield.state.enabled, true);
});

test('the renderer hooks: refresh repaints on a change, act toggles and toasts, a new agent resets', async () => {
  let renders = 0;
  const toasts = [];
  let gen = 1;
  const api = fakeApi([ok(false), ok(false), {supported: false}], [ok(true, 1)]);
  const shield = createPrivacyShield(api, {
    render: () => { renders++; }, toast: (t) => toasts.push(t), shown: () => false, gen: () => gen,
  });
  await shield.refresh();
  assert.equal(shield.state.enabled, false);
  await shield.act('toggle');
  assert.equal(shield.state.enabled, true);
  assert.deepEqual(toasts, ['Privacy Shield on']);
  assert.ok(renders >= 2);
  gen = 2;
  await shield.refresh();
  assert.equal(shield.state.supported, true);
  await shield.refresh();
  assert.equal(shield.state.supported, false);
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
    return [200, {enabled, masked: 3, sessions: 1}];
  });
  try {
    const got = await s.client.privacyShield();
    assert.deepEqual(got, {supported: true, ok: true, data: {enabled: false, masked: 3, localNames: null}});
    assert.equal(s.seen[0].method, 'GET');
    assert.equal(s.seen[0].url, '/api/privacy-shield');
    const set = await s.client.privacyShield(true);
    assert.equal(set.ok, true);
    assert.equal(set.data.enabled, true);
    assert.equal(s.seen[1].method, 'POST');
    assert.deepEqual(JSON.parse(s.seen[1].body), {enabled: true});
  } finally { await s.close(); }
  const bad = await standIn(() => [200, {masked: 1}]);
  try {
    const got = await bad.client.privacyShield();
    assert.equal(got.ok, false);
    assert.equal(got.supported, true);
  } finally { await bad.close(); }
  const old = await standIn(() => [404, {error: {message: 'No route for GET /api/privacy-shield'}}]);
  try {
    assert.deepEqual(await old.client.privacyShield(), {supported: false});
    assert.deepEqual(await old.client.privacyShield(true), {supported: false});
  } finally { await old.close(); }
});

test('ATO-2744: a failed read says so in a sentence, never "Error: ..." or a lowercase phrase', async () => {
  const shield = createPrivacyShield({read: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:7777'); }, set: async () => null});
  await shield.load();
  assert.equal(shield.state.error.text, "Couldn't read Privacy Shield from the agent.");
  assert.match(shield.state.error.detail, /ECONNREFUSED/);
  const html = privacyShieldHTML(shield.state, {esc});
  const shown = html.slice(0, html.indexOf('<details'));
  assert.doesNotMatch(shown, /ECONNREFUSED|Error:|could not read Privacy Shield|unknown error/);
  assert.match(html, /<summary>Details<\/summary><pre class="herr-raw">Error: connect ECONNREFUSED 127\.0\.0\.1:7777<\/pre>/);
  const empty = createPrivacyShield(fakeApi([{supported: true, ok: false}]));
  await empty.load();
  assert.deepEqual(empty.state.error, {text: "Couldn't read Privacy Shield from the agent.", detail: ''});
  assert.doesNotMatch(privacyShieldHTML(empty.state, {esc}), /<details/);
});
