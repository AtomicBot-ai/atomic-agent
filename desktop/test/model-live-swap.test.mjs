import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { restartsAgent, restartAfterSwitch, agentStarting } = require('../out/main/backend-switch.js');

/**
 * ATO-1021: a cloud model pick main judged swappable (`live`) is taken by the
 * running agent through `liveSwap` (POST /api/llm/active) instead of a restart.
 * Anything the live swap does not take falls back to the restart as before.
 */
function agent({ swap = async () => true, turns = 0 } = {}) {
  const calls = { restart: 0, swap: 0 };
  return {
    calls,
    turnsInFlight: () => turns,
    restart: async () => { calls.restart += 1; },
    liveSwap: async (res) => { calls.swap += 1; return swap(res); },
  };
}
const PICK = { ok: true, providerId: 'cloud', model: 'm2', transport: 'native_tools', daemon: 'untouched', restart: true };

beforeEach(() => {
  agentStarting();   // no restart owed from an earlier case
  restartsAgent(null);
});

test('a live pick is swapped, not restarted', async () => {
  const a = agent();
  restartsAgent(a);
  assert.deepEqual(await restartAfterSwitch(PICK, true, false, true), { restart: false, liveSwapped: true });
  assert.deepEqual(a.calls, { restart: 0, swap: 1 });
});

test('a swap the agent does not take restarts as before', async () => {
  const a = agent({ swap: async () => false });
  restartsAgent(a);
  assert.deepEqual(await restartAfterSwitch(PICK, true, false, true), { restart: true });
  assert.deepEqual(a.calls, { restart: 1, swap: 1 });
});

test('a swap that throws restarts as before', async () => {
  const a = agent({ swap: async () => { throw new Error('boom'); } });
  restartsAgent(a);
  assert.deepEqual(await restartAfterSwitch(PICK, true, false, true), { restart: true });
  assert.equal(a.calls.restart, 1);
});

test('a move main did not judge live is restarted without asking', async () => {
  const a = agent();
  restartsAgent(a);
  assert.deepEqual(await restartAfterSwitch(PICK, true, false, false), { restart: true });
  assert.deepEqual(a.calls, { restart: 1, swap: 0 });
});

test('a drifted route is never swapped live', async () => {
  const a = agent();
  restartsAgent(a);
  await restartAfterSwitch({ ...PICK, daemon: 'superseded' }, true, true, true);
  assert.deepEqual(a.calls, { restart: 1, swap: 0 });
});

test('under a turn in flight the restart is held and nothing is swapped', async () => {
  const a = agent({ turns: 1 });
  restartsAgent(a);
  assert.deepEqual(await restartAfterSwitch(PICK, true, false, true), { restart: false, restartHeld: true });
  assert.deepEqual(a.calls, { restart: 0, swap: 0 });
});

test('a swap the agent refuses for a turn it runs (409) holds the restart instead of cutting that turn', async () => {
  const a = agent({ swap: async () => 'busy' });
  restartsAgent(a);
  assert.deepEqual(await restartAfterSwitch(PICK, true, false, true), { restart: false, restartHeld: true });
  assert.deepEqual(a.calls, { restart: 0, swap: 1 });
});

test('a live pick never pays a restart an earlier switch owes: the owed restart runs instead', async () => {
  // A switch under a running turn leaves a restart owed ...
  let turns = 1;
  const a = { calls: { restart: 0, swap: 0 }, turnsInFlight: () => turns, restart: async () => { a.calls.restart += 1; }, liveSwap: async () => { a.calls.swap += 1; return true; } };
  restartsAgent(a);
  assert.deepEqual(await restartAfterSwitch(PICK, true, false, false), { restart: false, restartHeld: true });
  // ... and the next pick, live-swappable, restarts rather than swapping over it.
  turns = 0;
  assert.deepEqual(await restartAfterSwitch(PICK, true, false, true), { restart: true });
  assert.deepEqual(a.calls, { restart: 1, swap: 0 });
});
