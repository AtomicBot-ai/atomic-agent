import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withSwitchStandIn, selectFusionModel, selectComposerEngine, stopDaemonNow } = require('../out/main/backend-switch.js');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** Only the stand-in's in-memory config and daemon change; no real CLI runs. */
function fixture({ worker = 'local-llama', pause = 'models list' } = {}) {
  let config = {
    llm: {
      activeTextProvider: 'cloud',
      providers: [
        { id: 'cloud', kind: 'openai-compatible', apiKey: 'fixture-key', defaultChatModel: 'planner' },
        { id: 'second', kind: 'openai-compatible', apiKey: 'fixture-key', defaultChatModel: 'worker' },
        { id: 'local-llama', kind: 'llama-server' },
      ],
      runMode: { mode: 'fusion', fusion: { orchestratorProvider: 'cloud', workerProvider: worker } },
    },
    localModels: { mode: 'managed', managed: { engine: 'llama-server', modelId: 'old' }, embeddings: { enabled: false } },
    memory: { embeddings: { enabled: false } },
  };
  let up = false;
  let paused = false;
  const entered = deferred(), resume = deferred(), calls = [];
  const said = stdout => ({ ok: true, stdout, stderr: '' });
  const answer = async (args, input) => {
    const verb = args.slice(0, 2).join(' ');
    calls.push(verb);
    if (verb === pause && !paused) {
      paused = true;
      entered.resolve();
      await resume.promise;
    }
    switch (verb) {
      case 'config get': return said(JSON.stringify(config));
      case 'config set': config = JSON.parse(input); return said('');
      case 'models list': return said('ID | FAMILY | SIZE | CONTEXT | DL | ACTIVE\nold | qwen | 4B | 32k | yes | *\nnew | qwen | 4B | 32k | yes |\n');
      case 'models list-embeddings': return { ok: false, stdout: '', stderr: 'no embeddings in this fixture' };
      case 'models use': config.localModels.managed.modelId = args[2]; return said('');
      case 'models engine': config.localModels.managed.engine = args[2]; return said('');
      case 'models status': return said(`mode: managed\ndaemon: ${up ? 'running (pid 4242)  http://127.0.0.1:19191' : 'stopped'}\nhealth: ${up ? 'ok' : 'down'}\n`);
      case 'models stop': up = false; return said('stopped');
      case 'models start': up = true; return said('chat: started pid 4242, healthy on port 19191\n');
      default: throw new Error(`Unexpected fixture command: ${verb}`);
    }
  };
  return {
    calls, entered, resume,
    get config() { return config; },
    get up() { return up; },
    run: body => withSwitchStandIn(answer, body, { configHint: () => config, daemonPidAlive: () => up }),
  };
}

test('Stop during a Fusion model lookup prevents a late config change and model start', { timeout: 5000 }, async () => {
  const f = fixture();
  await f.run(async () => {
    const pick = selectFusionModel('worker', 'new');
    await f.entered.promise;
    try { await stopDaemonNow(); } finally { f.resume.resolve(); }
    const result = await pick;
    assert.equal(result.daemon, 'superseded');
    assert.equal(result.restart, false);
    assert.equal(f.config.localModels.managed.modelId, 'old');
    assert.equal(f.config.llm.runMode.fusion.workerModel, undefined);
    assert.equal(f.calls.includes('models use'), false);
    assert.equal(f.calls.includes('models start'), false);
    assert.equal(f.up, false);
  });
});

test('Stop during a composer engine lookup prevents a late Fusion pin and model start', { timeout: 5000 }, async () => {
  const f = fixture({ worker: 'second', pause: 'config get' });
  await f.run(async () => {
    const pick = selectComposerEngine('atomic-core', 'worker');
    await f.entered.promise;
    try { await stopDaemonNow(); } finally { f.resume.resolve(); }
    const result = await pick;
    assert.equal(result.daemon, 'superseded');
    assert.equal(result.restart, false);
    assert.equal(f.config.localModels.managed.engine, 'llama-server');
    assert.equal(f.config.llm.runMode.fusion.workerProvider, 'second');
    assert.equal(f.calls.includes('models engine'), false);
    assert.equal(f.calls.includes('models start'), false);
    assert.equal(f.up, false);
  });
});

test('Stop while the engine choice saves its Fusion pin prevents the subsequent model start', { timeout: 5000 }, async () => {
  const f = fixture({ worker: 'second', pause: 'config set' });
  await f.run(async () => {
    const pick = selectComposerEngine('atomic-core', 'worker');
    await f.entered.promise;
    try { await stopDaemonNow(); } finally { f.resume.resolve(); }
    const result = await pick;
    // The write was already dispatched: it may finish, but must not start
    // the engine or restart the agent after the newer Stop request.
    assert.equal(result.daemon, 'superseded');
    assert.equal(result.restart, false);
    assert.equal(f.calls.includes('models start'), false);
    assert.equal(f.up, false);
  });
});

test('Stop during a cloud model change prevents the local worker from restarting', { timeout: 5000 }, async () => {
  const f = fixture();
  await f.run(async () => {
    const pick = selectFusionModel('orchestrator', 'new-cloud-model');
    await f.entered.promise;
    try { await stopDaemonNow(); } finally { f.resume.resolve(); }
    const result = await pick;
    assert.equal(result.daemon, 'superseded');
    assert.equal(result.restart, false);
    assert.equal(f.calls.includes('models start'), false);
    assert.equal(f.up, false);
  });
});
