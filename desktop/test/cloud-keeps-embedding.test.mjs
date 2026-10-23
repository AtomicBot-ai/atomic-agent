import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withSwitchStandIn, switchBackend } = require('../out/main/backend-switch.js');

/**
 * ATO-377: Local -> Cloud stops only the chat server (`models stop --chat-only`)
 * and leaves memory.embeddings.enabled on when the agent kept the embedding
 * server. An older agent ignores the flag, stops both and prints `stopped`:
 * the flag then goes off as before. Only the stand-in's config and daemon change.
 */
function fixture({ chatOnly }) {
  let config = {
    llm: {
      activeTextProvider: 'local-llama',
      providers: [
        { id: 'local-llama', kind: 'llama-server', url: 'http://127.0.0.1:19091' },
        { id: 'cloud', kind: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', defaultChatModel: 'm' },
      ],
    },
    localModels: { mode: 'managed', managed: { modelId: 'qwen-3.5-4b', port: 19091 }, embeddings: { enabled: true, modelId: 'embeddinggemma-2' } },
    memory: { embeddings: { enabled: true } },
  };
  let up = true;
  const argv = [];
  const said = stdout => ({ ok: true, stdout, stderr: '' });
  const answer = async (args, input) => {
    argv.push([...args]);
    switch (args.slice(0, 2).join(' ')) {
      case 'config get': return said(JSON.stringify(config));
      case 'config set': config = JSON.parse(input); return said('');
      case 'models status': return said(`mode: managed\ndaemon: ${up ? 'running (pid 4242)  http://127.0.0.1:19091' : 'stopped'}\nhealth: ${up ? 'ok' : 'down'}\n`);
      case 'models stop':
        up = false;
        return said(chatOnly && args[2] === '--chat-only' ? 'stopped chat model; embedding model kept for memory search\n' : 'stopped\n');
      default: throw new Error(`Unexpected fixture command: ${args.join(' ')}`);
    }
  };
  return {
    argv,
    get config() { return config; },
    run: body => withSwitchStandIn(answer, body, { configHint: () => config, daemonPidAlive: () => up, tell: () => {} }),
  };
}

test('Cloud switch keeps the embedding server and hybrid recall on an agent with --chat-only', { timeout: 5000 }, async () => {
  const f = fixture({ chatOnly: true });
  const res = await f.run(() => switchBackend('cloud'));
  assert.equal(res.ok, true);
  assert.equal(res.daemon, 'stopped');
  assert.equal(res.embeddingKept, true);
  assert.equal(res.daemonLine, 'local-llm: chat server stopped, memory search stays on');
  assert.deepEqual(f.argv.filter(a => a[0] === 'models' && a[1] === 'stop'), [['models', 'stop', '--chat-only']]);
  assert.equal(f.argv.filter(a => a[0] === 'config' && a[1] === 'set').length, 1);
  assert.equal(f.config.memory.embeddings.enabled, true);
  assert.equal(f.config.llm.activeTextProvider, 'cloud');
});

test('Cloud switch on an older agent stops both and turns hybrid recall off, as before', { timeout: 5000 }, async () => {
  const f = fixture({ chatOnly: false });
  const res = await f.run(() => switchBackend('cloud'));
  assert.equal(res.ok, true);
  assert.equal(res.daemon, 'stopped');
  assert.equal(res.embeddingKept, undefined);
  assert.equal(f.config.memory.embeddings.enabled, false);
  assert.equal(f.config.llm.activeTextProvider, 'cloud');
});
