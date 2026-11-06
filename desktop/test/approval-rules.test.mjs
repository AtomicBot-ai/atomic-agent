// ATO-1144: Settings › Privacy › Approval rules (renderer/approval-rules.js)
// and its transport (AgentClient.approvalRules / deleteApprovalRule, built output).
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {ARULES_EMPTY, ARULES_OLD_AGENT, arulesHere, arulesSentence, arulesScope, arulesAdded,
  createApprovalRules, approvalRulesHTML} = require('../renderer/approval-rules.js');
const { AgentClient } = require('../out/main/agent-client.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const deps = {esc, categoryPlain: (c) => ({shell: 'run a terminal command'}[c] || ''), pathText: (p) => p};

const gitRule = {id: 'r_1', decision: 'allow', tool: 'os.shell.run', category: 'shell', commandPrefix: ['git', 'status'],
  project: '/repo', createdAt: '2026-11-06T10:00:00Z', source: 'prompt'};
const everywhere = {id: 'r_2', decision: 'allow', tool: 'os.fs.write', category: 'fs_write_workspace', createdAt: '2026-11-01T08:00:00Z', source: 'prompt'};
const projDeny = {id: 'p_1', decision: 'deny', commandPrefix: ['rm'], note: 'never delete here'};
const list = (over = {}) => Object.assign({rules: [gitRule, everywhere], globalPath: '/home/u/.atomic-agent/approval-rules.json',
  projectPath: '/repo/.atomic-agent/approval-rules.json', projectRules: [projDeny]}, over);

function fakeApi(reads, removes = []) {
  const calls = [];
  return {calls, read: async (id) => { calls.push({read: id ?? null}); return reads.shift(); },
    remove: async (id) => { calls.push({remove: id}); return removes.shift(); }};
}

test('a rule reads as one plain line', () => {
  assert.equal(arulesSentence(gitRule, deps), 'Always allow "git status"');
  assert.equal(arulesSentence(projDeny, deps), 'Never allow "rm"');
  assert.equal(arulesSentence({decision: 'ask', commandPrefix: ['git', 'push']}, deps), 'Always ask before "git push"');
  assert.equal(arulesSentence({decision: 'allow', category: 'shell'}, deps), 'Always allow: run a terminal command');
  assert.equal(arulesSentence({decision: 'allow', tool: 'os.fs.write', category: 'fs_write_workspace'}, deps), 'Always allow the os.fs.write tool');
  assert.equal(arulesSentence({decision: 'allow', commandPrefix: ['ls'], path: '/repo/src'}, deps), 'Always allow "ls" in /repo/src');
});

test('where a rule applies: this project, another project, everywhere', () => {
  assert.equal(arulesHere(list()), '/repo');
  assert.equal(arulesScope(gitRule, '/repo').text, 'this project');
  assert.equal(arulesScope(gitRule, '/repo/').text, 'this project', 'a trailing slash is the same folder');
  assert.equal(arulesScope(gitRule, '/other').text, 'project repo');
  assert.equal(arulesScope(everywhere, '/repo').text, 'everywhere');
});

test('the date reads as a day, and a rule without one has none', () => {
  assert.equal(arulesAdded(gitRule), 'added 6 Nov 2026');
  assert.equal(arulesAdded({}), '');
  assert.equal(arulesAdded({createdAt: 'not a date'}), '');
});

test('the list: own rules with Delete, project rules read-only with where they come from', async () => {
  const api = fakeApi([{supported: true, ok: true, data: list()}]);
  const ar = createApprovalRules(api);
  await ar.load('ses1');
  assert.deepEqual(api.calls, [{read: 'ses1'}]);
  const html = approvalRulesHTML(ar.state, deps);
  assert.match(html, /Approval rules/);
  assert.match(html, /Always allow &quot;git status&quot;/);
  assert.match(html, /this project<\/span> · added 6 Nov 2026/);
  assert.match(html, /everywhere<\/span> · added 1 Nov 2026/);
  assert.match(html, /data-act="arules:del:r_1"/);
  assert.match(html, /data-act="arules:del:r_2"/);
  assert.ok(!html.includes('arules:del:p_1'), 'a project rule has no Delete');
  assert.match(html, /Never allow &quot;rm&quot;.*from \.atomic-agent\/approval-rules\.json in this project · never delete here/);
});

test('an allow rule in the project file is not shown: the agent ignores it', async () => {
  const ar = createApprovalRules(fakeApi([{supported: true, ok: true, data: list({projectRules: [projDeny, {id: 'p_2', decision: 'allow', commandPrefix: ['curl']}]})}]));
  await ar.load();
  assert.deepEqual(ar.state.data.projectRules.map((r) => r.id), ['p_1']);
});

test('no rules: the empty line says how to add one', async () => {
  const ar = createApprovalRules(fakeApi([{supported: true, ok: true, data: list({rules: [], projectRules: []})}]));
  await ar.load();
  const html = approvalRulesHTML(ar.state, deps);
  assert.ok(html.includes(esc(ARULES_EMPTY)));
  assert.ok(!html.includes('tk-list'));
  assert.ok(!/ — /.test(ARULES_EMPTY));
});

test('an agent from before the route: update the agent, nothing to delete', async () => {
  const ar = createApprovalRules(fakeApi([{supported: false}]));
  await ar.load();
  assert.equal(ar.state.supported, false);
  const html = approvalRulesHTML(ar.state, deps);
  assert.ok(html.includes(ARULES_OLD_AGENT));
  assert.ok(!html.includes('arules:del'));
});

test('a failed read says so with Try again; a late older read is dropped', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const reads = [slow, {supported: true, ok: false, error: 'boom'}];
  const ar = createApprovalRules({read: () => reads.shift(), remove: async () => ({ok: true})});
  const first = ar.load();
  await ar.load();
  release({supported: true, ok: true, data: list()});
  await first;
  assert.equal(ar.state.data, null, 'the older answer did not land');
  const html = approvalRulesHTML(ar.state, deps);
  assert.match(html, /boom <button class="set-link" data-act="arules:reload">Try again<\/button>/);
});

test('Delete removes the rule; one already gone goes too; a failure keeps it and says so', async () => {
  const api = fakeApi([{supported: true, ok: true, data: list()}],
    [{ok: true}, {ok: false, error: 'disk full'}, {ok: false, notFound: true, error: 'not found'}]);
  const ar = createApprovalRules(api);
  await ar.load();
  assert.deepEqual(await ar.remove('r_1'), {ok: true});
  assert.deepEqual(ar.state.data.rules.map((r) => r.id), ['r_2']);
  const failed = await ar.remove('r_2');
  assert.equal(failed.ok, false);
  assert.deepEqual(ar.state.data.rules.map((r) => r.id), ['r_2']);
  assert.match(approvalRulesHTML(ar.state, deps), /Couldn’t delete the rule: disk full/);
  assert.deepEqual(await ar.remove('r_2'), {ok: true});
  assert.deepEqual(ar.state.data.rules, []);
  assert.deepEqual(await ar.remove('p_1'), {ok: false}, 'a project rule is never sent');
  assert.deepEqual(api.calls.filter((c) => c.remove), [{remove: 'r_1'}, {remove: 'r_2'}, {remove: 'r_2'}]);
});

test('Delete on an agent that lost the route turns the block into the update line', async () => {
  const ar = createApprovalRules(fakeApi([{supported: true, ok: true, data: list()}], [{supported: false}]));
  await ar.load();
  assert.equal((await ar.remove('r_1')).unsupported, true);
  assert.equal(ar.state.supported, false);
});

test('rule ids and labels are escaped', async () => {
  const ar = createApprovalRules(fakeApi([{supported: true, ok: true, data: list({rules: [Object.assign({}, gitRule, {id: 'r_"x', commandPrefix: ['<img>']})], projectRules: []})}]));
  await ar.load();
  const html = approvalRulesHTML(ar.state, deps);
  assert.ok(!html.includes('<img>'));
  assert.ok(html.includes('arules:del:r_&quot;x'));
});

/** An agent stand-in for the client half. */
async function standIn(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({method: req.method, url: req.url, body});
      const [code, json] = answer(req);
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

test('client: list, delete, a missing rule, and an agent from before the route', async () => {
  const s = await standIn((req) => {
    if (req.method === 'GET') return [200, list()];
    if (req.url.endsWith('/r_1')) return [200, {removed: true}];
    return [404, {error: {message: 'rule not found'}}];
  });
  try {
    const got = await s.client.approvalRules('ses/1');
    assert.equal(got.ok, true);
    assert.equal(got.data.rules.length, 2);
    assert.equal(s.seen[0].url, '/api/approval-rules?sessionId=ses%2F1');
    assert.deepEqual(await s.client.deleteApprovalRule('r_1'), {ok: true});
    assert.equal(s.seen[1].method, 'DELETE');
    assert.equal(s.seen[1].url, '/api/approval-rules/r_1');
    assert.deepEqual(await s.client.deleteApprovalRule('r_9'), {ok: false, notFound: true, error: 'rule not found'});
  } finally { await s.close(); }
  const old = await standIn(() => [404, {error: {message: 'No route for GET /api/approval-rules'}}]);
  try {
    assert.deepEqual(await old.client.approvalRules(), {supported: false});
    assert.deepEqual(await old.client.deleteApprovalRule('r_1'), {supported: false});
  } finally { await old.close(); }
});
