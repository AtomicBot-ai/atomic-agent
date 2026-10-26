import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Any call that falls through to the CLI fails loudly: there is no agent binary here.
process.env.ATOMIC_AGENT_BIN = '/nonexistent/atag-for-config-over-agent-test';
const require = createRequire(import.meta.url);
const { useConfigRoute, readWholeConfig, upsertProvider, setProviderModel } = require('../out/main/agent-cli.js');

/**
 * ATO-1022: while `atag serve` is up, config reads and whole-file writes go
 * through its routes, not an `atag config` process each. The route keeps the
 * compare-and-swap: a write refused because the file moved re-reads and re-plans.
 */
function route(initial) {
  let config = structuredClone(initial);
  let sha = 'a'.repeat(64);
  const calls = { read: 0, write: [] };
  let refuseNext = 0;
  return {
    calls,
    refuse(n) { refuseNext = n; },
    get config() { return config; },
    read: async () => { calls.read += 1; return { sha256: sha, config: structuredClone(config) }; },
    write: async (json, expect) => {
      calls.write.push(expect);
      if (refuseNext > 0) { refuseNext -= 1; sha = 'b'.repeat(64); return { ok: false, conflicted: true, error: 'config changed since it was read' }; }
      config = JSON.parse(json);
      sha = 'c'.repeat(64);
      return { ok: true };
    },
  };
}
const CFG = {
  llm: {
    activeTextProvider: 'cloud',
    providers: [
      { id: 'local-llama', kind: 'llama-server', url: 'http://127.0.0.1:19091' },
      { id: 'cloud', kind: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', apiKey: 'k', defaultChatModel: 'm1' },
    ],
  },
  localModels: { mode: 'managed', managed: { port: 19091 } },
};

afterEach(() => useConfigRoute(null));

test('a read goes through the agent, no process', async () => {
  const r = route(CFG);
  useConfigRoute(r);
  const read = await readWholeConfig();
  assert.equal(read.ok, true);
  assert.equal(read.config.llm.activeTextProvider, 'cloud');
  assert.equal(r.calls.read, 1);
});

test('a model pick writes through the agent against the hash it read', async () => {
  const r = route(CFG);
  useConfigRoute(r);
  const res = await setProviderModel('cloud', 'm2');
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(r.calls.write, ['a'.repeat(64)]);
  assert.equal(r.config.llm.providers.find((p) => p.id === 'cloud').defaultChatModel, 'm2');
});

test('re-picking the model already set writes nothing', async () => {
  const r = route(CFG);
  useConfigRoute(r);
  const res = await setProviderModel('cloud', 'm1');
  assert.equal(res.ok, true, res.error);
  assert.equal(r.calls.write.length, 0);
});

test('a write refused because the file moved is read and planned again', async () => {
  const r = route(CFG);
  useConfigRoute(r);
  r.refuse(1);
  const res = await upsertProvider({ id: 'cloud', kind: '', defaultChatModel: 'm3' });
  assert.equal(res.ok, true, res.error);
  assert.equal(r.calls.read, 2);
  assert.deepEqual(r.calls.write, ['a'.repeat(64), 'b'.repeat(64)]);
});

test('an agent that cannot answer sends the call to the CLI', async () => {
  useConfigRoute({ read: async () => null, write: async () => null });
  const read = await readWholeConfig();
  assert.equal(read.ok, false);   // the CLI was asked, and there is no binary here
});
