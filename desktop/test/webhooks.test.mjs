// ATO-445: Settings › Tasks › Webhooks (renderer/webhooks.js), the IPC field
// check (main/webhooks-ipc.ts) and the transport (AgentClient.webhooks /
// createWebhook / deleteWebhook), built output.
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {WHK_OLD_AGENT, WHK_EMPTY, whkPreset, whkNameOk, whkSuggestName, whkUrl, whkFormError,
  createWebhooks, webhooksHTML} = require('../renderer/webhooks.js');
const { cleanWebhookCreate, webhookNameOk } = require('../out/main/webhooks-ipc.js');
const { AgentClient } = require('../out/main/agent-client.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const deps = {esc};

const gh = {name: 'github', path: '/api/webhooks/github', verify: 'github', sessionMode: 'ephemeral', userMessageTemplate: 't', hasSecret: true, live: true};
const listAnswer = (webhooks = [gh], over = {}) => ({supported: true, ok: true, baseUrl: 'http://127.0.0.1:4100', remote: false,
  data: {webhooks, tasksEnabled: true, presets: ['header', 'github', 'stripe', 'standard']}, ...over});

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
  assert.equal(whkSuggestName('header', []), 'webhook');
  assert.equal(whkUrl('http://127.0.0.1:4100/', '/api/webhooks/a'), 'http://127.0.0.1:4100/api/webhooks/a');
  assert.equal(whkUrl('', '/api/webhooks/a'), '/api/webhooks/a');
  assert.equal(whkPreset('nope')[0], 'header');
});

test('the form says what is missing', () => {
  const ok = {name: 'pay', verify: 'stripe', template: 'paid', secret: 'whsec_x'};
  assert.equal(whkFormError(ok, []), '');
  assert.match(whkFormError({...ok, name: 'bad name'}, []), /letters, digits/);
  assert.match(whkFormError(ok, [{name: 'pay'}]), /already exists/);
  assert.match(whkFormError({...ok, template: '  '}, []), /what the agent should do/);
  assert.match(whkFormError({...ok, secret: ''}, []), /signing secret from Stripe/);
  assert.equal(whkFormError({...ok, verify: 'standard', secret: ''}, []), '');
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
  assert.match(html, /http:\/\/127\.0\.0\.1:4100\/api\/webhooks\/github/);
  assert.match(html, /can’t deliver to this address yet/);

  w.openForm('github');
  assert.equal(w.state.form.name, 'github-2');
  w.setPreset('stripe');
  assert.equal(w.state.form.name, 'stripe');
  assert.match(w.state.form.template, /\{\{body\.type\}\}/);
  // Stripe needs its secret pasted before anything is sent.
  assert.equal((await w.create()).ok, false);
  assert.equal(api.calls.filter((c) => c.create).length, 0);
  w.type('secret', ' whsec_from_stripe ');
  assert.equal((await w.create()).ok, true);
  assert.deepEqual(api.calls.find((c) => c.create).create,
    {name: 'stripe', verify: 'stripe', userMessageTemplate: 'Stripe sent a {{body.type}} event ({{body.id}}). Summarise it and say if anything needs doing.', secret: 'whsec_from_stripe'});
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
  w.openForm('standard');
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
  w.openForm('header');
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
  assert.match(html, /https:\/\/vps\.example:8080\/api\/webhooks\/github/);
  assert.match(html, /API key/);
});

test('names and template text are escaped', async () => {
  const w = createWebhooks(fakeApi({reads: [listAnswer([])]}));
  await w.load();
  w.openForm('header');
  w.type('template', '<img src=x onerror=alert(1)>');
  assert.doesNotMatch(webhooksHTML(w.state, deps), /<img/);
});

test('ipc: only known fields in known forms reach the agent', () => {
  assert.deepEqual(cleanWebhookCreate({name: 'gh', verify: 'github', userMessageTemplate: ' hi ', secret: '', extra: 1}),
    {ok: true, body: {name: 'gh', verify: 'github', userMessageTemplate: 'hi'}});
  assert.deepEqual(cleanWebhookCreate({name: 'pay', verify: 'stripe', userMessageTemplate: 'x', secret: ' whsec_1 '}).body.secret, 'whsec_1');
  assert.equal(cleanWebhookCreate({name: 'gh', userMessageTemplate: 'x'}).body.verify, 'header');
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
    if (req.method === 'GET') return [200, {webhooks: [gh], tasksEnabled: true}];
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
