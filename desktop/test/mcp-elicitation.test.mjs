// ATO-1492: an MCP server's question to the person (renderer/mcp-elicitation.js)
// and its transport (AgentClient.answerMcpElicitation, eventsFrameChannel; built output).
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const R = require('../renderer/mcp-elicitation.js');
const { AgentClient, eventsFrameChannel } = require('../out/main/agent-client.js');

const PICK = [
  {name: 'account', kind: 'enum', required: true, sensitive: false, options: [{value: 'work', label: 'Work'}, {value: 'home', label: 'Home'}]},
  {name: 'count', title: 'How many', kind: 'number', integer: true, required: false, sensitive: false},
  {name: 'pin', kind: 'string', required: false, sensitive: true},
  {name: 'notify', kind: 'boolean', required: false, sensitive: false, default: true},
  {name: 'tags', kind: 'multi_enum', required: false, sensitive: false, options: [{value: 'a', label: 'A'}]},
];

test('a question with no fields is a plain confirm', () => {
  assert.equal(R.mcpElicitIsConfirm({server: 's', message: 'Go?', fields: []}), true);
  assert.equal(R.mcpElicitIsConfirm({server: 's', message: 'Pick', fields: PICK}), false);
  assert.equal(R.mcpElicitTitle({server: 'github'}), 'github asks');
});

test('defaults: a field default, false for a box, an empty list for a multi-pick', () => {
  assert.deepEqual(R.mcpElicitDefaults(PICK), {notify: true, tags: []});
});

test('content: numbers are numbers, empty optional fields are left out', () => {
  const got = R.mcpElicitContent(PICK, {account: 'home', count: ' 3 ', pin: '', notify: false, tags: []});
  assert.deepEqual(got, {ok: true, content: {account: 'home', count: 3, notify: false}});
});

test('content: a missing required field or a bad number names the field, never the value', () => {
  assert.deepEqual(R.mcpElicitContent(PICK, {}), {ok: false, error: 'account is required'});
  const bad = R.mcpElicitContent(PICK, {account: 'work', count: '2.5'});
  assert.deepEqual(bad, {ok: false, error: 'How many must be a whole number'});
  assert.doesNotMatch(bad.error, /2\.5/);
});

test('a sensitive field is drawn as a password box', () => {
  const src = readFileSync(new URL('../renderer/mcp-elicitation.js', import.meta.url), 'utf8');
  assert.match(src, /f\.sensitive \? 'password'/);
});

test('a field name from the server never lands in an attribute raw (review fix)', () => {
  // renderer.js defines esc(); the same function, for the module run alone.
  globalThis.esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const evil = 'a" data-act="session:new" style="position:fixed;inset:0;opacity:0';
  for (const kind of ['string', 'boolean', 'enum', 'number']) {
    const f = {name: evil, kind, required: false, sensitive: false, options: [{value: 'x', label: 'X'}]};
    const html = R.mcpElicitFieldHTML(f, {}, 2);
    assert.doesNotMatch(html, /data-act="/, kind);
    assert.doesNotMatch(html, /style="position/, kind);
    assert.match(html, /id="mcpel-2"/, kind);
  }
});

test('events frames: elicitation frames never reach the approval path', () => {
  assert.equal(eventsFrameChannel('mcp_elicitation'), 'mcpElicitation');
  assert.equal(eventsFrameChannel('mcp_elicitation_closed'), 'mcpElicitationClosed');
  assert.equal(eventsFrameChannel('approval_request'), 'approval');
  assert.equal(eventsFrameChannel('message'), 'approval');
});

test('the renderer and main answer through their own route, not agent:approve', () => {
  const main = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
  assert.match(main, /ipcMain\.handle\("agent:mcpElicitationAnswer"/);
  const src = readFileSync(new URL('../renderer/mcp-elicitation.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /BR\.approve\(/);
});

async function standIn(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({method: req.method, url: req.url, body});
      const [code, json] = answer(req, body);
      res.writeHead(code, {'content-type': 'application/json'});
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new AgentClient(process.cwd());
  client.port = server.address().port;
  client.token = 't0ken';
  return {client, seen, close: () => new Promise((resolve) => server.close(resolve))};
}

test('client: accept, a refused answer, and a question already closed', async () => {
  const s = await standIn((_req, body) => {
    const b = JSON.parse(body);
    if (b.id === 'gone') return [404, {error: {message: 'elicitation not pending: gone'}}];
    if (b.content && b.content.account === 'x') return [400, {error: {message: 'answer does not fit the form: field account does not fit its schema'}}];
    return [200, {resolved: true}];
  });
  try {
    assert.deepEqual(await s.client.answerMcpElicitation('e1', 'accept', {account: 'home'}), {ok: true});
    assert.equal(s.seen[0].method, 'POST');
    assert.equal(s.seen[0].url, '/api/mcp/elicitation/answer');
    assert.deepEqual(JSON.parse(s.seen[0].body), {id: 'e1', action: 'accept', content: {account: 'home'}});
    const bad = await s.client.answerMcpElicitation('e1', 'accept', {account: 'x'});
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 400);
    assert.deepEqual(await s.client.answerMcpElicitation('gone', 'decline'),
      {ok: false, status: 404, error: 'elicitation not pending: gone'});
    assert.deepEqual(JSON.parse(s.seen[2].body), {id: 'gone', action: 'decline'});
  } finally { await s.close(); }
});
