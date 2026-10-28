// ATO-1250: the desktop's "Trust this folder?" question (renderer/project-trust.js)
// and its transport (AgentClient.projectTrust / answerProjectTrust, built output).
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {projectTrustLine, projectTrustSummary, createProjectTrust} = require('../renderer/project-trust.js');
const { AgentClient } = require('../out/main/agent-client.js');

const empty = () => ({skills: [], instructions: []});
function status(over = {}) {
  return Object.assign({workingDir: '/repo', pending: empty(), trusted: empty(), declined: empty(),
    questionId: null, question: null, hasEarlierAnswer: false, hint: 'atomic-agent skill project on --workspace /repo'}, over);
}
const asking = (over = {}) => status(Object.assign({pending: {skills: ['deploy'], instructions: ['AGENTS.md']},
  questionId: 'q1', question: 'This folder has 1 project skill and AGENTS.md. Trust them?'}, over));

/** A stand-in for the agent's route: GET answers `reads`, POST records the body and answers `answers`. */
function fakeApi(reads, answers = []) {
  const posted = [];
  return {posted, read: async (id) => { posted.push({read: id ?? null}); return reads.shift(); },
    answer: async (body) => { posted.push(body); return answers.shift(); }};
}

test('a folder with pending items asks, with one plain line on what loads', async () => {
  const api = fakeApi([{supported: true, ok: true, status: asking()}]);
  const pt = createProjectTrust(api);
  const q = await pt.check('ses-1');
  assert.equal(q.question, 'This folder has 1 project skill and AGENTS.md. Trust them?');
  assert.equal(projectTrustLine(q), "Trust lets the agent read the instructions in AGENTS.md and the skill deploy from this folder. Don't trust loads nothing from it and is not asked again.");
  assert.deepEqual(api.posted, [{read: 'ses-1'}]);
});

test('trust sends exactly the shown question and closes the dialog', async () => {
  const api = fakeApi([{supported: true, ok: true, status: asking()}],
    [{ok: true, status: status({trusted: {skills: ['deploy'], instructions: ['AGENTS.md']}})}]);
  const pt = createProjectTrust(api);
  await pt.check('ses-1');
  const res = await pt.answer('trust', 'ses-1');
  assert.equal(res.ok, true);
  assert.deepEqual(api.posted[1], {sessionId: 'ses-1', answer: 'trust', questionId: 'q1'});
  assert.equal(pt.state.question, null);
  assert.equal(projectTrustSummary(pt.state.status).state, 'trusted');
});

test('decline is recorded, and the agent no longer asks for that folder', async () => {
  const declinedStatus = status({declined: {skills: ['deploy'], instructions: ['AGENTS.md']}, hasEarlierAnswer: true});
  const api = fakeApi([{supported: true, ok: true, status: asking()}, {supported: true, ok: true, status: declinedStatus}],
    [{ok: true, status: declinedStatus}]);
  const pt = createProjectTrust(api);
  await pt.check(null);
  await pt.answer('decline', null);
  // No session: the folder the question was about, never "whatever serve started in".
  assert.deepEqual(api.posted[1], {workingDir: '/repo', answer: 'decline', questionId: 'q1'});
  assert.equal(await pt.check(null), null);
  const sum = projectTrustSummary(pt.state.status);
  assert.equal(sum.state, 'declined'); assert.equal(sum.canTrust, true); assert.equal(sum.canDecline, false);
});

test('a folder that changed under the question asks again with what is there now', async () => {
  const fresh = asking({questionId: 'q2', question: 'This folder has 2 project skills and AGENTS.md. Trust them?',
    pending: {skills: ['deploy', 'new-one'], instructions: ['AGENTS.md']}});
  const api = fakeApi([{supported: true, ok: true, status: asking()}], [{ok: false, conflict: true, status: fresh}]);
  const pt = createProjectTrust(api);
  await pt.check('ses-1');
  const res = await pt.answer('trust', 'ses-1');
  assert.equal(res.conflict, true);
  assert.equal(pt.state.question.questionId, 'q2');
  assert.equal(pt.state.error, null);
});

test('not now closes the dialog for that folder only, recording nothing', async () => {
  const other = asking({workingDir: '/other'});
  const api = fakeApi([{supported: true, ok: true, status: asking()}, {supported: true, ok: true, status: asking()},
    {supported: true, ok: true, status: other}]);
  const pt = createProjectTrust(api);
  await pt.check('a');
  pt.dismiss();
  assert.equal(pt.state.question, null);
  assert.equal(await pt.check('a'), null);   // the same folder stays quiet until the app starts again
  assert.equal((await pt.check('b')).workingDir, '/other');   // another folder still asks
  assert.equal(api.posted.filter((x) => !('read' in x)).length, 0);
});

test('an agent without the route shows nothing and never asks again', async () => {
  const api = fakeApi([{supported: false}]);
  const pt = createProjectTrust(api);
  assert.equal(await pt.check('ses-1'), null);
  assert.equal(pt.state.supported, false);
  assert.equal(await pt.check('ses-1'), null);
  assert.equal(api.posted.length, 1);
  assert.deepEqual(await pt.answer('trust', 'ses-1'), {ok: false});
  assert.deepEqual(await pt.setAll(true, 'ses-1'), {ok: false});
});

test('a failed read keeps the last question and says why; a late answer for another chat is dropped', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const reads = [slow, Promise.resolve({supported: true, ok: false, error: 'HTTP 500'})];
  const pt = createProjectTrust({read: () => reads.shift(), answer: async () => ({ok: true})});
  const first = pt.check('old-chat');
  assert.equal(await pt.check('new-chat'), null);
  assert.equal(pt.state.error, 'HTTP 500');
  release({supported: true, ok: true, status: asking()});
  assert.equal(await first, null);
  assert.equal(pt.state.question, null);
});

test('settings switch changes an earlier answer for everything in the folder', async () => {
  const declinedStatus = status({declined: {skills: ['deploy'], instructions: []}});
  const api = fakeApi([{supported: true, ok: true, status: declinedStatus}],
    [{ok: true, status: status({trusted: {skills: ['deploy'], instructions: []}})}]);
  const pt = createProjectTrust(api);
  await pt.check('ses-1');
  await pt.setAll(true, 'ses-1');
  assert.deepEqual(api.posted[1], {sessionId: 'ses-1', answer: 'trust', scope: 'all'});
  assert.equal(projectTrustSummary(pt.state.status).state, 'trusted');
});

test('summary states', () => {
  assert.equal(projectTrustSummary(status()).state, 'none');
  assert.equal(projectTrustSummary(asking()).state, 'pending');
  assert.equal(projectTrustSummary(status({trusted: {skills: ['a'], instructions: []}, declined: {skills: ['b'], instructions: []}})).state, 'mixed');
  assert.equal(projectTrustSummary(null), null);
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

test('client: an agent from before the route is unsupported, a missing chat is an error', async () => {
  const s = await standIn((req) => req.url.includes('missing')
    ? [404, {error: {message: 'session not found'}}]
    : [404, {error: {message: 'No route for GET /api/project-trust'}}]);
  try {
    assert.deepEqual(await s.client.projectTrust('ses/1'), {supported: false});
    assert.equal(s.seen[0].url, '/api/project-trust?sessionId=ses%2F1');
    assert.deepEqual(await s.client.projectTrust('missing'), {supported: true, ok: false, error: 'session not found'});
    assert.deepEqual(await s.client.answerProjectTrust({answer: 'trust', questionId: 'q'}), {supported: false});
  } finally { await s.close(); }
});

test('client: 409 question_changed carries the fresh status; an older route without scope says so', async () => {
  const fresh = asking({questionId: 'q2'});
  const s = await standIn((req) => {
    const body = JSON.parse(req.url && req.method === 'POST' ? s.seen.at(-1).body : '{}');
    if (body.scope === 'all') return [400, {error: {message: 'questionId is required'}}];
    return [409, {error: {code: 'question_changed', message: 'changed'}, status: fresh}];
  });
  try {
    assert.deepEqual(await s.client.answerProjectTrust({answer: 'trust', questionId: 'q1'}), {ok: false, conflict: true, status: fresh});
    const old = await s.client.answerProjectTrust({answer: 'trust', scope: 'all'});
    assert.equal(old.ok, false); assert.match(old.error, /update it/);
  } finally { await s.close(); }
});
