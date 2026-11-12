import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Anything that falls through to the CLI here would hit this machine's agent; point it nowhere.
process.env.ATOMIC_AGENT_BIN = '/nonexistent/atag-for-remote-models-test';
const require = createRequire(import.meta.url);
const { useRemoteModels, modelsList, modelsUse, modelsPull, modelsStatus, modelsListEmbeddings, servedModels, REMOTE_MODELS_HERE } = require('../out/main/agent-cli.js');

/**
 * ATO-1127 (Nadya 26.10): connected to an agent on another computer,
 * Settings › Models lists THAT computer's models, and model changes are
 * refused in words instead of acting on this computer.
 */
const LIST = 'ID | FAMILY | SIZE | CONTEXT | DL | ACTIVE\nremote-only | qwen | 4B | 32k | yes | *\nother | qwen | 9B | 32k | no |\n';

afterEach(() => useRemoteModels(null));

test('the model list comes from the remote agent', async () => {
  const asked = [];
  useRemoteModels({ text: async (view) => { asked.push(view); return LIST; } });
  const res = await modelsList();
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.models.map((m) => m.id), ['remote-only', 'other']);
  assert.equal(res.models[0].active, true);
  assert.deepEqual(asked, ['list']);
});

test('an agent that cannot say its models is an error, not this machine\'s list', async () => {
  useRemoteModels({ text: async () => null });
  const res = await modelsList();
  assert.equal(res.ok, false);
  assert.match(res.error, /other computer/);
});

test('switching the model while remote is refused in words', async () => {
  let asked = 0;
  useRemoteModels({ text: async () => { asked += 1; return LIST; } });
  const res = await modelsUse('other');
  assert.equal(res.ok, false);
  assert.equal(res.error, REMOTE_MODELS_HERE);
  assert.equal(asked, 0);
});

test('a download while remote starts nothing on this computer', async () => {
  useRemoteModels({ text: async () => LIST });
  const lines = [];
  const pull = modelsPull('other', (l) => lines.push(l));
  const res = await pull.done;
  assert.equal(res.ok, false);
  assert.equal(res.error, REMOTE_MODELS_HERE);
  assert.deepEqual(lines, []);
});

test('the status comes from the remote agent too', async () => {
  const asked = [];
  useRemoteModels({ text: async (view) => { asked.push(view); return 'mode: managed\n'; } });
  await modelsStatus();
  assert.deepEqual(asked, ['status']);
});

// ATO-1213: the remote's embedding models, and no "now" line from this Mac's ports.
const EMB = 'ID                       | SIZE   | DIM | POOLING | DL  | ACTIVE\n'
  + 'remote-embed             | 300MB  | 768 | mean    | yes | *\n'
  + '\nembedding daemon: running (pid 4242) on port 19092, health: ok\n';

test('the embedding models come from the remote agent', async () => {
  const asked = [];
  useRemoteModels({ text: async (view) => { asked.push(view); return EMB; } });
  const res = await modelsListEmbeddings();
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.models.map((m) => [m.id, m.downloaded, m.active]), [['remote-embed', true, true]]);
  assert.equal(res.daemon.pid, 4242);
  assert.deepEqual(asked, ['list-embeddings']);
});

test('a remote agent too old to list embeddings gives an empty list, not this machine\'s', async () => {
  useRemoteModels({ text: async () => null });
  const res = await modelsListEmbeddings();
  assert.equal(res.ok, true);
  assert.deepEqual(res.models, []);
});

test('while remote, nothing on this Mac is probed for the "now" line', async () => {
  useRemoteModels({ text: async () => LIST });
  const t0 = Date.now();
  const res = await servedModels();
  assert.deepEqual(res, { ok: true, chat: { answered: false, ids: [] }, embedding: { answered: false, ids: [] } });
  assert.ok(Date.now() - t0 < 200, 'answered without a network probe');
});
