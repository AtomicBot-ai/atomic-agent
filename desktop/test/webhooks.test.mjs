// ATO-445: Settings › Tasks › Webhooks (renderer/webhooks.js), the IPC field
// check (main/webhooks-ipc.ts) and the transport (AgentClient.webhooks /
// createWebhook / deleteWebhook), built output.
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {WHK_OLD_AGENT, WHK_EMPTY, WHK_TUNNEL_HOWTO, WHK_PRESETS, whkPreset, whkPresetsFor, whkNameOk, whkSuggestName, whkUrl, whkTunnel, whkPublicUrl, whkFormError,
  createWebhooks, webhooksHTML} = require('../renderer/webhooks.js');
const { readFileSync } = require('node:fs');
const { cleanWebhookCreate, webhookNameOk } = require('../out/main/webhooks-ipc.js');
const { AgentClient } = require('../out/main/agent-client.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const deps = {esc};

/* The agent's reply: ATO-625's GET /api/webhooks plus ATO-445's verify, userMessageTemplate, live and presets. */
const gh = {name: 'github', path: '/api/webhooks/github', hasSecret: true, sessionMode: 'ephemeral', publicUrl: null,
  verify: 'github', userMessageTemplate: 't', live: true};
const OFF = {state: 'off', mode: null, publicUrl: null, error: null};
const listAnswer = (webhooks = [gh], over = {}) => ({supported: true, ok: true, baseUrl: 'http://127.0.0.1:4100', remote: false,
  data: {tasksEnabled: true, tunnel: OFF, webhooks, presets: ['secret', 'github', 'standard-webhooks', 'stripe']}, ...over});

function fakeApi({reads = [], creates = [], removes = []} = {}) {
  const calls = [];
  return {calls,
    read: async () => { calls.push({read: true}); return reads.shift(); },
    create: async (body) => { calls.push({create: body}); return creates.shift(); },
    remove: async (name) => { calls.push({remove: name}); return removes.shift(); }};
}

test('names, suggestions and addresses', () => {
  assert.equal(whkNameOk('github-2'), true);
  assert.equal(whkNameOk('has space'), false);
  assert.equal(whkNameOk('__proto__'), false);
  assert.equal(whkNameOk('x'.repeat(65)), false);
  assert.equal(whkSuggestName('github', []), 'github');
  assert.equal(whkSuggestName('github', [{name: 'github'}, {name: 'github-2'}]), 'github-3');
  assert.equal(whkSuggestName('secret', []), 'webhook');
  assert.equal(whkSuggestName('standard-webhooks', []), 'standard');
  assert.equal(whkUrl('http://127.0.0.1:4100/', '/api/webhooks/a'), 'http://127.0.0.1:4100/api/webhooks/a');
  assert.equal(whkUrl('', '/api/webhooks/a'), '/api/webhooks/a');
  // Unknown or missing verify is the agent's default, the shared secret.
  assert.equal(whkPreset('nope')[0], 'secret');
  assert.equal(whkPreset(undefined)[0], 'secret');
  assert.deepEqual(WHK_PRESETS.map((p) => p[0]), ['github', 'stripe', 'standard-webhooks', 'secret']);
});

test('the form says what is missing', () => {
  const ok = {name: 'pay', verify: 'stripe', template: 'paid', secret: 'whsec_x'};
  assert.equal(whkFormError(ok, []), '');
  assert.match(whkFormError({...ok, name: 'bad name'}, []), /letters, digits/);
  assert.match(whkFormError(ok, [{name: 'pay'}]), /already exists/);
  assert.match(whkFormError({...ok, template: '  '}, []), /what the agent should do/);
  assert.match(whkFormError({...ok, secret: ''}, []), /signing secret from Stripe/);
  assert.equal(whkFormError({...ok, verify: 'standard-webhooks', secret: ''}, []), '');
});

test('list, add a route, the secret shows once, then it is gone', async () => {
  const api = fakeApi({
    reads: [listAnswer()],
    creates: [{ok: true, data: {webhook: {name: 'stripe', path: '/api/webhooks/stripe', verify: 'stripe', hasSecret: true, live: true}, secret: 'whsec_from_stripe'}}],
  });
  const w = createWebhooks(api);
  await w.load();
  assert.equal(w.state.data.webhooks.length, 1);
  let html = webhooksHTML(w.state, deps);
  // No tunnel: the path only, never the agent's own loopback address, and how to turn the tunnel on.
  assert.match(html, /<code>\/api\/webhooks\/github<\/code>/);
  assert.doesNotMatch(html, /127\.0\.0\.1/);
  assert.doesNotMatch(html, /whk:copyurl:github/);
  assert.match(html, /atag serve --tunnel/);

  w.openForm('github');
  assert.equal(w.state.form.name, 'github-2');
  w.setPreset('stripe');
  assert.equal(w.state.form.name, 'stripe');
  assert.match(w.state.form.template, /\{\{event\}\}/);
  // Stripe needs its secret pasted before anything is sent.
  assert.equal((await w.create()).ok, false);
  assert.equal(api.calls.filter((c) => c.create).length, 0);
  w.type('secret', ' whsec_from_stripe ');
  assert.equal((await w.create()).ok, true);
  assert.deepEqual(api.calls.find((c) => c.create).create,
    {name: 'stripe', verify: 'stripe', userMessageTemplate: 'Stripe sent a {{event}} event ({{delivery}}). Summarise it and say if anything needs doing.', secret: 'whsec_from_stripe'});
  assert.equal(w.state.form, null);
  html = webhooksHTML(w.state, deps);
  assert.match(html, /whsec_from_stripe/);
  assert.match(html, /not shown again/);
  assert.match(html, /data-act="whk:copysecret"/);
  w.dismissCreated();
  html = webhooksHTML(w.state, deps);
  assert.doesNotMatch(html, /whsec_from_stripe/);
  assert.equal(w.state.data.webhooks.length, 2);
});

test('a typed name and prompt survive a preset change; github sends no secret', async () => {
  const api = fakeApi({reads: [listAnswer([])], creates: [{ok: true, data: {webhook: {name: 'ci', path: '/api/webhooks/ci', verify: 'github'}, secret: 'abc'}}]});
  const w = createWebhooks(api);
  await w.load();
  w.openForm('standard-webhooks');
  w.type('name', 'ci');
  w.type('template', 'CI said {{body.status}}');
  w.type('secret', 'whsec_typed');
  w.setPreset('github');
  assert.equal(w.state.form.name, 'ci');
  assert.equal(w.state.form.template, 'CI said {{body.status}}');
  assert.equal(w.state.form.secret, '');
  await w.create();
  assert.deepEqual(api.calls.find((c) => c.create).create, {name: 'ci', verify: 'github', userMessageTemplate: 'CI said {{body.status}}'});
});

test('a conflict or error stays on the form', async () => {
  const api = fakeApi({reads: [listAnswer([])], creates: [{ok: false, conflict: true, error: 'webhook already exists: a'}]});
  const w = createWebhooks(api);
  await w.load();
  w.openForm('secret');
  w.type('name', 'a');
  await w.create();
  assert.notEqual(w.state.form, null);
  assert.equal(w.state.formError, 'webhook already exists: a');
  assert.match(webhooksHTML(w.state, deps), /webhook already exists: a/);
});

test('delete asks first, then removes; a route already gone is gone here too', async () => {
  const other = {...gh, name: 'other', path: '/api/webhooks/other'};
  const api = fakeApi({reads: [listAnswer([gh, other])], removes: [{ok: true}, {ok: false, notFound: true, error: 'webhook not found'}]});
  const w = createWebhooks(api);
  await w.load();
  // No confirm yet: nothing is sent.
  assert.equal((await w.remove('github')).ok, false);
  assert.equal(api.calls.filter((c) => c.remove).length, 0);
  w.askDelete('github');
  assert.match(webhooksHTML(w.state, deps), /Delete “github”\?/);
  w.cancelDelete();
  assert.doesNotMatch(webhooksHTML(w.state, deps), /Delete “github”\?/);
  w.askDelete('github');
  assert.equal((await w.remove('github')).ok, true);
  w.askDelete('other');
  assert.equal((await w.remove('other')).ok, true);
  assert.deepEqual(w.state.data.webhooks, []);
  assert.match(webhooksHTML(w.state, deps), new RegExp(WHK_EMPTY.slice(0, 20)));
});

test('an agent from before the routes, a read error, tasks off, a remote agent', async () => {
  const w = createWebhooks(fakeApi({reads: [{supported: false}]}));
  await w.load();
  assert.match(webhooksHTML(w.state, deps), new RegExp(WHK_OLD_AGENT));
  const e = createWebhooks(fakeApi({reads: [{supported: true, ok: false, error: 'boom'}]}));
  await e.load();
  assert.match(webhooksHTML(e.state, deps), /boom/);
  assert.match(webhooksHTML(e.state, deps), /whk:reload/);
  const off = createWebhooks(fakeApi({reads: [listAnswer([gh], {data: {webhooks: [gh], tasksEnabled: false}})]}));
  await off.load();
  assert.match(webhooksHTML(off.state, deps), /Tasks are off/);
  const remote = createWebhooks(fakeApi({reads: [listAnswer([gh], {remote: true, baseUrl: 'https://vps.example:8080'})]}));
  await remote.load();
  const html = webhooksHTML(remote.state, deps);
  // A remote agent's own address is not a webhook address either: only the tunnel is.
  assert.doesNotMatch(html, /vps\.example/);
  assert.match(html, /atag serve --tunnel/);
});

test('tunnel up: the public address is shown and copied; a route without a secret gets none', async () => {
  const plain = {...gh, name: 'plain', path: '/api/webhooks/plain', verify: 'secret', hasSecret: false};
  const tunnel = {state: 'up', mode: 'quick', publicUrl: 'https://calm-words.trycloudflare.com', error: null};
  const w = createWebhooks(fakeApi({reads: [listAnswer([gh, plain], {data: {webhooks: [gh, plain], tasksEnabled: true, tunnel}})],
    creates: [{ok: true, data: {webhook: {name: 'github-2', path: '/api/webhooks/github-2', verify: 'github', hasSecret: true, live: true}, secret: 'abc'}}]}));
  await w.load();
  assert.equal(whkPublicUrl(w.state, gh), 'https://calm-words.trycloudflare.com/api/webhooks/github');
  assert.equal(whkPublicUrl(w.state, plain), '');
  // A route's own publicUrl (ATO-625's GET /api/webhooks) wins.
  assert.equal(whkPublicUrl(w.state, {...gh, publicUrl: 'https://hooks.example.com/api/webhooks/github'}), 'https://hooks.example.com/api/webhooks/github');
  const html = webhooksHTML(w.state, deps);
  assert.match(html, /https:\/\/calm-words\.trycloudflare\.com\/api\/webhooks\/github/);
  assert.match(html, /whk:copyurl:github"/);
  assert.doesNotMatch(html, /whk:copyurl:plain/);
  assert.match(html, /tunnel turns it away/);
  assert.doesNotMatch(html, /atag serve --tunnel/);
  w.openForm('github');
  assert.equal((await w.create()).ok, true);
  assert.equal(w.state.created.url, 'https://calm-words.trycloudflare.com/api/webhooks/github-2');
  // Tunnel states and junk values.
  assert.equal(whkTunnel(null), null);
  assert.equal(whkTunnel({state: 'up', publicUrl: 'http://plain.example'}).publicUrl, null);
  assert.equal(whkTunnel({state: 'starting', publicUrl: 'https://x.trycloudflare.com'}).publicUrl, null);
  const failed = createWebhooks(fakeApi({reads: [listAnswer([gh], {data: {webhooks: [gh], tasksEnabled: true, tunnel: {state: 'failed', error: 'cloudflared exited'}}})]}));
  await failed.load();
  const fh = webhooksHTML(failed.state, deps);
  assert.match(fh, /tunnel stopped \(cloudflared exited\)/);
  assert.match(fh, /atag serve --tunnel/);
});

test('decision: no webhook text tells the user to use the API key or open the main port', async () => {
  const states = [
    listAnswer(),
    listAnswer([gh], {remote: true, baseUrl: 'https://vps.example:8080'}),
    listAnswer([gh], {data: {webhooks: [gh], tasksEnabled: false, tunnel: {state: 'failed', error: 'x'}}}),
    listAnswer([gh], {data: {webhooks: [gh], tasksEnabled: true, tunnel: {state: 'up', publicUrl: 'https://a.trycloudflare.com'}}}),
  ];
  for (const answer of states) {
    const w = createWebhooks(fakeApi({reads: [answer]}));
    await w.load();
    for (const verify of ['github', 'stripe', 'standard-webhooks', 'secret']) {
      w.openForm(verify);
      const html = webhooksHTML(w.state, deps);
      assert.doesNotMatch(html, /API key|0\.0\.0\.0|--host|open (a|the) port/i);
    }
  }
  assert.match(WHK_TUNNEL_HOWTO, /own secret/);
  // The files this change adds never bind the agent anywhere but loopback.
  for (const f of ['../renderer/webhooks.js', '../main/webhooks-ipc.ts']) {
    const code = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /0\.0\.0\.0|--host|\.listen\(/);
  }
});

test('the merged reply: presets from the agent, a route without verify, one not loaded yet', async () => {
  // An agent with only ATO-625's list sends no verify, template, live or presets.
  const bare = {name: 'old', path: '/api/webhooks/old', hasSecret: true, sessionMode: 'ephemeral', publicUrl: null};
  const later = {...gh, name: 'later', path: '/api/webhooks/later', live: false};
  const w = createWebhooks(fakeApi({reads: [listAnswer([bare, later], {data: {tasksEnabled: true, tunnel: OFF, webhooks: [bare, later], presets: ['secret', 'github']}})]}));
  await w.load();
  assert.deepEqual(w.state.data.presets, ['secret', 'github']);
  assert.deepEqual(whkPresetsFor(w.state.data).map((p) => p[0]), ['github', 'secret']);
  assert.deepEqual(whkPresetsFor({presets: ['gitlab']}).map((p) => p[0]), WHK_PRESETS.map((p) => p[0]));
  assert.deepEqual(whkPresetsFor(null).map((p) => p[0]), WHK_PRESETS.map((p) => p[0]));
  w.openForm('github');
  const html = webhooksHTML(w.state, deps);
  assert.match(html, /data-act="whk:preset:secret"/);
  assert.doesNotMatch(html, /data-act="whk:preset:stripe"/);
  assert.match(html, /data-whk="old"><div class="body"><div class="t">old <span class="d">Shared secret</);
  assert.match(html, /starts after the agent restarts/);
});

test('names and template text are escaped', async () => {
  const w = createWebhooks(fakeApi({reads: [listAnswer([])]}));
  await w.load();
  w.openForm('secret');
  w.type('template', '<img src=x onerror=alert(1)>');
  assert.doesNotMatch(webhooksHTML(w.state, deps), /<img/);
});

test('ipc: only known fields in known forms reach the agent', () => {
  assert.deepEqual(cleanWebhookCreate({name: 'gh', verify: 'github', userMessageTemplate: ' hi ', secret: '', extra: 1}),
    {ok: true, body: {name: 'gh', verify: 'github', userMessageTemplate: 'hi'}});
  // A bind host or port never rides along to the agent.
  assert.deepEqual(Object.keys(cleanWebhookCreate({name: 'gh', userMessageTemplate: 'x', host: '0.0.0.0', http: {host: '0.0.0.0'}, port: 80}).body).sort(),
    ['name', 'userMessageTemplate', 'verify']);
  assert.deepEqual(cleanWebhookCreate({name: 'pay', verify: 'stripe', userMessageTemplate: 'x', secret: ' whsec_1 '}).body.secret, 'whsec_1');
  assert.equal(cleanWebhookCreate({name: 'gh', userMessageTemplate: 'x'}).body.verify, 'secret');
  assert.equal(cleanWebhookCreate({name: 'std', verify: 'standard-webhooks', userMessageTemplate: 'x'}).ok, true);
  // The earlier draft names are not the agent's values and are refused here.
  assert.equal(cleanWebhookCreate({name: 'gh', verify: 'header', userMessageTemplate: 'x'}).ok, false);
  assert.equal(cleanWebhookCreate({name: 'gh', verify: 'standard', userMessageTemplate: 'x'}).ok, false);
  assert.equal(cleanWebhookCreate({name: 'a b', userMessageTemplate: 'x'}).ok, false);
  assert.equal(cleanWebhookCreate({name: 'gh', verify: 'gitlab', userMessageTemplate: 'x'}).ok, false);
  assert.equal(cleanWebhookCreate({name: 'gh', userMessageTemplate: ''}).ok, false);
  assert.equal(cleanWebhookCreate({name: 'gh', userMessageTemplate: 'x'.repeat(4001)}).ok, false);
  assert.equal(cleanWebhookCreate(null).ok, false);
  assert.equal(webhookNameOk('ok_1'), true);
  assert.equal(webhookNameOk('../x'), false);
});

/** An agent stand-in for the client half. */
async function standIn(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({method: req.method, url: req.url, body, auth: req.headers.authorization});
      const [code, json] = answer(req);
      res.writeHead(code, {'content-type': 'application/json'});
      res.end(typeof json === 'string' ? json : JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new AgentClient(process.cwd());
  client.port = server.address().port;
  client.token = 't0ken';
  return {client, seen, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve))};
}

test('client: list, create, delete, a conflict, and an agent from before the routes', async () => {
  const s = await standIn((req) => {
    if (req.method === 'GET') return [200, {tasksEnabled: true, tunnel: OFF, webhooks: [gh], presets: ['secret', 'github', 'standard-webhooks', 'stripe']}];
    if (req.method === 'POST') return [201, {webhook: gh, secret: 's3cret'}];
    if (req.url.endsWith('/github')) return [200, {deleted: 'github'}];
    return [404, {error: {message: 'webhook not found: nope'}}];
  });
  try {
    const got = await s.client.webhooks();
    assert.equal(got.ok, true);
    assert.equal(got.baseUrl, `http://127.0.0.1:${s.port}`);
    assert.equal(got.remote, false);
    assert.equal(s.seen[0].url, '/api/webhooks');
    assert.equal(s.seen[0].auth, 'Bearer t0ken');
    const made = await s.client.createWebhook({name: 'github', verify: 'github', userMessageTemplate: 't'});
    assert.deepEqual(made, {ok: true, data: {webhook: gh, secret: 's3cret'}});
    assert.deepEqual(JSON.parse(s.seen[1].body), {name: 'github', verify: 'github', userMessageTemplate: 't'});
    assert.deepEqual(await s.client.deleteWebhook('github'), {ok: true});
    assert.equal(s.seen[2].method, 'DELETE');
    assert.deepEqual(await s.client.deleteWebhook('nope'), {ok: false, notFound: true, error: 'webhook not found: nope'});
  } finally { await s.close(); }
  const dup = await standIn(() => [409, {error: {message: 'webhook already exists: github'}}]);
  try {
    assert.deepEqual(await dup.client.createWebhook({name: 'github'}), {ok: false, conflict: true, error: 'webhook already exists: github'});
  } finally { await dup.close(); }
  const old = await standIn((req) => [404, {error: {message: `No route for ${req.method} ${req.url}`}}]);
  try {
    assert.deepEqual(await old.client.webhooks(), {supported: false});
    assert.deepEqual(await old.client.createWebhook({name: 'a'}), {supported: false});
    assert.deepEqual(await old.client.deleteWebhook('a'), {supported: false});
  } finally { await old.close(); }
});
