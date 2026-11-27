// ATO-2527: Settings › Privacy › Privacy Shield › names row
// (renderer/privacy-names.js, the state in renderer/privacy-shield.js)
// and its transport (AgentClient.privacyShield with `localNames`, built output).
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {NAMES_OLD_AGENT, readNamesStatus, namesHint, namesToast, privacyNamesHTML} = require('../renderer/privacy-names.js');
const {createPrivacyShield} = require('../renderer/privacy-shield.js');
const { AgentClient } = require('../out/main/agent-client.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const READY = {enabled: true, state: 'ready', model: {provider: 'lmstudio', model: 'qwen3-4b'}};
const ok = (enabled, localNames) => ({supported: true, ok: true, data: {enabled, masked: 0, localNames}});

function fakeApi(reads, sets = []) {
  const calls = [];
  return {calls, read: async () => { calls.push('read'); return reads.shift(); },
    set: async () => ({supported: false}),
    setNames: async (on) => { calls.push({names: on}); return sets.shift(); }};
}

test('the status is checked, not trusted', () => {
  assert.deepEqual(readNamesStatus(READY), READY);
  assert.equal(readNamesStatus(null), null);
  assert.equal(readNamesStatus({enabled: 'yes', state: 'ready'}), null);
  assert.equal(readNamesStatus({enabled: true, state: 'later'}), null);
  assert.deepEqual(readNamesStatus({enabled: false, state: 'off', model: {provider: 7}}), {enabled: false, state: 'off', model: null});
});

test('the hint names the model and says what happens without one', () => {
  assert.equal(namesHint(READY, true),
    'Uses qwen3-4b on this computer to find them before a request goes to a cloud model. If that model isn’t running, only emails, phone numbers, cards and keys are hidden.');
  assert.match(namesHint(READY, false), /^Works when Privacy Shield is on\. /);
  assert.match(namesHint({enabled: true, state: 'no-local-model', model: null}, true),
    /^Needs a model running on this computer: the built-in local model, or LM Studio or Ollama\. None is set up, so only emails/);
  assert.match(namesHint({enabled: false, state: 'off', model: {provider: 'local-llama', model: null}}, true), /^When on, local-llama on this computer/);
});

test('loading, old agent, ready and no-model rows are shaped alike', async () => {
  const loading = createPrivacyShield(fakeApi([]));
  assert.equal(privacyNamesHTML(loading.state, {esc}), '');

  const old = createPrivacyShield(fakeApi([ok(true, undefined)]));
  await old.load();
  const oldHtml = privacyNamesHTML(old.state, {esc});
  assert.ok(oldHtml.includes(esc(NAMES_OLD_AGENT)));
  assert.match(oldHtml, /data-act="shield:names" disabled/);

  const ready = createPrivacyShield(fakeApi([ok(true, READY)]));
  await ready.load();
  const readyHtml = privacyNamesHTML(ready.state, {esc});
  assert.match(readyHtml, /Uses qwen3-4b on this computer/);
  assert.match(readyHtml, /aria-checked="true"/);
  assert.doesNotMatch(readyHtml, / disabled/);

  const none = createPrivacyShield(fakeApi([ok(true, {enabled: true, state: 'no-local-model', model: null})]));
  await none.load();
  const noneHtml = privacyNamesHTML(none.state, {esc});
  assert.match(noneHtml, /tk-help--warn/);
  assert.match(noneHtml, /data-act="settings:llm:local"/);
});

test('the switch asks the agent, shows its answer, and a failure keeps the old state with a retry', async () => {
  const api = fakeApi([ok(true, {...READY, enabled: false, state: 'off'})], [ok(true, READY), {supported: true, ok: false, error: 'config is read-only'}]);
  const toasts = [];
  const shield = createPrivacyShield(api, {render: () => {}, toast: (t) => toasts.push(t), shown: () => false});
  await shield.load();
  await shield.act('names');
  assert.deepEqual(api.calls, ['read', {names: true}]);
  assert.equal(shield.state.names.enabled, true);
  assert.deepEqual(toasts, ['Hiding names on']);
  assert.deepEqual(await shield.toggleNames(), {ok: false});
  assert.equal(shield.state.names.enabled, true);
  assert.equal(shield.state.error, null);
  assert.equal(shield.state.namesError, 'Couldn’t switch hiding names: config is read-only');
  assert.match(privacyNamesHTML(shield.state, {esc}), /set-names-err[\s\S]*data-act="shield:reload"/);
});

test('the toast after the switch claims hiding only when it will happen (F2021.1)', async () => {
  const cases = [
    // [shield on, the agent's answer, the detail must match]
    [false, {enabled: true, state: 'no-local-model', model: null}, /Works when Privacy Shield is on/],
    [true, {enabled: true, state: 'no-local-model', model: null}, /Needs a model on this computer/],
    [false, READY, /Works when Privacy Shield is on/],
    [true, {...READY, state: 'provider-not-shielded'}, /isn’t covered by Privacy Shield/],
    [true, READY, /A model on this computer hides names/],
  ];
  for (const [shieldOn, names, detail] of cases) {
    const off = {...names, enabled: false, state: 'off'};
    const api = fakeApi([ok(shieldOn, off)], [ok(shieldOn, names)]);
    const toasts = [];
    const shield = createPrivacyShield(api, {render: () => {}, toast: (t, d) => toasts.push([t, d]), shown: () => false});
    await shield.load();
    await shield.act('names');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0][0], 'Hiding names on');
    assert.match(toasts[0][1], detail);
    if (!(shieldOn && names.state === 'ready')) assert.doesNotMatch(toasts[0][1], /hides/);
  }
  assert.deepEqual(namesToast({...READY, enabled: false, state: 'off'}, true), ['Hiding names off', 'Names go to cloud models as written']);
});

test('a chat model the shield does not cover is said, not promised', () => {
  const names = readNamesStatus({...READY, state: 'provider-not-shielded'});
  assert.equal(names.state, 'provider-not-shielded');
  assert.match(namesHint(names, true), /isn’t covered by Privacy Shield, so nothing is hidden/);
  const shield = createPrivacyShield(fakeApi([]));
  Object.assign(shield.state, {supported: true, enabled: true, names});
  assert.match(privacyNamesHTML(shield.state, {esc}), /tk-help--warn/);
});

test('client: posts localNames alone and passes the status through', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({method: req.method, body});
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({enabled: true, masked: 0, sessions: 0, localNames: READY}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new AgentClient(process.cwd());
  client.port = server.address().port;
  client.token = 't0ken';
  try {
    const got = await client.privacyShield(undefined, true);
    assert.equal(seen[0].method, 'POST');
    assert.deepEqual(JSON.parse(seen[0].body), {localNames: true});
    assert.deepEqual(got.data.localNames, READY);
    await client.privacyShield();
    assert.equal(seen[1].method, 'GET');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
