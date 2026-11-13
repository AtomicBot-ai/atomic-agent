// ATO-1148: a project's own cloud model. A project is a chat's working
// folder; a cloud model picked in the switcher is remembered for it
// (main/project-model.ts), the window decides when it applies
// (renderer/project-model.js), and every turn carries it to the agent
// (AgentClient.chat → provider_id + provider_model) with no global switch.
// Run: npm run build && npm run test:unit
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../out/main/project-model.js');
const R = require('../renderer/project-model.js');
const { AgentClient } = require('../out/main/agent-client.js');

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'project-model-')); dirs.push(d); return d; };

const providers = [
  { id: 'local-llama', kind: 'llama-server', url: 'http://127.0.0.1:19091' },
  { id: 'lmstudio', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', defaultChatModel: 'qwen' },
  { id: 'openrouter', kind: 'openrouter', defaultChatModel: 'openai/gpt-5' },
  { id: 'anthropic', kind: 'openai-compatible', baseUrl: 'https://api.anthropic.com/v1', defaultChatModel: 'claude-sonnet-5' },
];

test('main: a folder\'s pick round-trips through project-models.json, and null forgets it', () => {
  const userData = scratch();
  const written = P.writeProjectModel(userData, '/work/site/', { providerId: 'openrouter', model: 'anthropic/claude-sonnet-5' });
  assert.deepEqual(written, { '/work/site': { providerId: 'openrouter', model: 'anthropic/claude-sonnet-5' } });
  assert.deepEqual(P.readProjectModels(userData), written);
  const body = JSON.parse(readFileSync(join(userData, 'project-models.json'), 'utf8'));
  assert.equal(body.version, 1);
  assert.deepEqual(P.writeProjectModel(userData, '/work/site', null), {});
  assert.deepEqual(P.readProjectModels(userData), {});
});

test('main: a corrupt or hand-edited file keeps only well-formed picks', () => {
  const userData = scratch();
  writeFileSync(join(userData, 'project-models.json'), 'not json');
  assert.deepEqual(P.readProjectModels(userData), {});
  assert.deepEqual(P.parseProjectModels(JSON.stringify({ folders: {
    '/ok': { providerId: 'openrouter', model: 'm' },
    '/no-model': { providerId: 'openrouter' },
    '/bad': { providerId: 'x', model: 'a\nb' },
    '/list': [],
  } })), { '/ok': { providerId: 'openrouter', model: 'm' } });
});

test('main: folder keys drop trailing separators, and Windows paths fold case and slashes', () => {
  assert.equal(P.folderKey('/Users/me/site/', 'darwin'), '/Users/me/site');
  assert.equal(P.folderKey('/', 'linux'), '/');
  assert.equal(P.folderKey('C:/Users/Me/Site\\', 'win32'), 'c:\\users\\me\\site');
  assert.equal(P.folderKey('D:\\', 'win32'), 'd:\\');
  assert.equal(R.projectFolderKey('C:/Users/Me/Site\\', true), P.folderKey('C:/Users/Me/Site\\', 'win32'));
  assert.equal(R.projectFolderKey('/Users/me/site/', false), P.folderKey('/Users/me/site/', 'darwin'));
});

test('main: only a configured cloud provider takes a project model; a remote agent takes none', () => {
  const pick = { providerId: 'openrouter', model: 'anthropic/claude-sonnet-5' };
  assert.deepEqual(P.turnModelFor(pick, providers), pick);
  assert.equal(P.turnModelFor({ providerId: 'local-llama', model: 'other.gguf' }, providers), null);
  assert.equal(P.turnModelFor({ providerId: 'lmstudio', model: 'llama' }, providers), null);
  assert.equal(P.turnModelFor({ providerId: 'gone', model: 'm' }, providers), null);
  assert.equal(P.turnModelFor(pick, providers, { remote: true }), null);
  assert.equal(P.LOCAL_MODEL_SHARED_NOTE, 'Local model is shared by all projects');
  assert.equal(R.PROJECT_LOCAL_NOTE, P.LOCAL_MODEL_SHARED_NOTE);
});

test('window: a chat in a project with a cloud model sends it on a cloud route, and only there', async () => {
  const folders = { '/work/site': { providerId: 'anthropic', model: 'claude-opus-5' } };
  const pm = R.createProjectModels({ win: false });
  assert.equal(await pm.load({ projectModels: async () => ({ ok: true, remote: false, folders, localNote: P.LOCAL_MODEL_SHARED_NOTE }) }), true);
  pm.noteChatFolder('chat-1', '/work/site/');
  const folder = pm.folderOf('chat-1', '/home/me');
  assert.deepEqual(pm.turnModel(folder, providers, 'cloud'), { providerId: 'anthropic', model: 'claude-opus-5' });
  // A new chat opens in the window's folder and starts with that folder's model.
  assert.deepEqual(pm.turnModel(pm.folderOf(null, '/work/site'), providers, 'cloud'), { providerId: 'anthropic', model: 'claude-opus-5' });
  // Another project keeps the agent's own model.
  assert.equal(pm.turnModel(pm.folderOf(null, '/work/other'), providers, 'cloud'), null);
  // Local and Fusion routes are one per agent.
  assert.equal(pm.turnModel(folder, providers, 'local'), null);
  assert.equal(pm.turnModel(folder, providers, 'fusion'), null);
  // A provider deleted since, or a remote agent: the agent's own model.
  assert.equal(pm.turnModel(folder, providers.filter((p) => p.id !== 'anthropic'), 'cloud'), null);
  const remote = R.createProjectModels({});
  await remote.load({ projectModels: async () => ({ ok: true, remote: true, folders }) });
  assert.equal(remote.turnModel('/work/site', providers, 'cloud'), null);
});

test('window: local model rows carry the shared note, and the local entries are never a project\'s', () => {
  const pm = R.createProjectModels({});
  assert.equal(pm.localNote(), 'Local model is shared by all projects');
  assert.equal(R.projectCloudEntry(providers[0]), false);
  assert.equal(R.projectCloudEntry(providers[1]), false);
  assert.equal(R.projectCloudEntry(providers[2]), true);
  assert.equal(R.projectPickApplies({ providerId: 'local-llama', model: 'x.gguf' }, providers, 'cloud'), null);
});

test('window: picking a project model writes the folder through the bridge, never the global switch', async () => {
  const calls = [];
  const api = {
    projectModels: async () => ({ ok: true, folders: {} }),
    setProjectModel: async (dir, pick) => { calls.push(['setProjectModel', dir, pick]); return { ok: true, folders: { [dir]: pick } }; },
    selectCloudModel: async () => { calls.push(['selectCloudModel']); return { ok: true }; },
    activateProvider: async () => { calls.push(['activateProvider']); return { ok: true }; },
  };
  const pm = R.createProjectModels({});
  await pm.load(api);
  const res = await pm.set(api, '/work/site', { providerId: 'openrouter', model: 'anthropic/claude-sonnet-5' });
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [['setProjectModel', '/work/site', { providerId: 'openrouter', model: 'anthropic/claude-sonnet-5' }]]);
  assert.deepEqual(pm.turnModel('/work/site', providers, 'cloud'), { providerId: 'openrouter', model: 'anthropic/claude-sonnet-5' });
});

test('client: a turn on the project\'s model sends provider_id + provider_model and never touches /api/llm/active', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-atomic-turn-model': 'openrouter/anthropic/claude-sonnet-5' });
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No route' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new AgentClient(process.cwd());
  client.port = server.address().port;
  client.token = 't0ken';
  try {
    await client.chat('turn-1', [{ role: 'user', content: 'hi' }], 'chat-1', '/work/site', { providerId: 'openrouter', model: 'anthropic/claude-sonnet-5' });
    await client.chat('turn-2', [{ role: 'user', content: 'hi' }], 'chat-2', '/work/other');
    const turns = seen.filter((r) => r.url === '/v1/chat/completions').map((r) => JSON.parse(r.body));
    assert.equal(turns.length, 2);
    assert.equal(turns[0].provider_id, 'openrouter');
    assert.equal(turns[0].provider_model, 'anthropic/claude-sonnet-5');
    assert.equal('provider_id' in turns[1], false);
    assert.equal('provider_model' in turns[1], false);
    assert.equal(seen.some((r) => r.url && r.url.startsWith('/api/llm/active')), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
