// ATO-2495 review: the T63 drift check must not fail a correct build.
// Run: npm run build && npm run test:unit (the smoke task is read from the built output).
// The agent's context preview reports the reserve its budget really held back.
// A bounded think block raises it (ATO-1295: 5024 on a 16k window, not the
// 4096 the renderer's port gives) and a cloud route holds the raw cap, so the
// port is compared only on the built-in local route with no reasoning budget.
// The popover draws the agent's figure on every route, and that is checked always.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { replyShareVerdict63 } = require('../out/main/smoke-tasks/t63.js');

const local16k = { replyCap: 16384, contextWindow: 16384, share: 0.5, ours: 4096,
  reasoningBudget: 0, providerId: 'local-llama' };

test('default local route: the port matches the agent, both checks pass', () => {
  const v = replyShareVerdict63({ ...local16k, reservedForReply: 4096, usageReserve: 4096, drawn: 4096 });
  assert.deepEqual(v, { agent: true, port: true });
});

test('default local route: a port that drifted from the agent still fails', () => {
  const v = replyShareVerdict63({ ...local16k, ours: 8192, reservedForReply: 4096, usageReserve: 4096, drawn: 4096 });
  assert.equal(v.port, false);
});

test('reasoning budget 4000 on 16k: the agent reports 5024, the port check skips, not fails', () => {
  const v = replyShareVerdict63({ ...local16k, reasoningBudget: 4000,
    reservedForReply: 5024, usageReserve: 5024, drawn: 5024 });
  assert.equal(v.agent, true);
  assert.equal(v.port, true);
  assert.match(v.portSkip, /reasoning budget/);
});

test('cloud route with a 96k cap: the agent holds the raw cap, the port check skips', () => {
  const v = replyShareVerdict63({ replyCap: 96000, contextWindow: 131072, share: 0.5, ours: 65536,
    reasoningBudget: 0, providerId: 'openrouter', reservedForReply: 96000, usageReserve: 96000, drawn: 96000 });
  assert.equal(v.agent, true);
  assert.equal(v.port, true);
  assert.match(v.portSkip, /local route/);
});

test('two different reserves in one reply, or a popover not drawing the agent figure, fail the agent check', () => {
  assert.equal(replyShareVerdict63({ ...local16k, reservedForReply: 4096, usageReserve: 5024, drawn: 5024 }).agent, false);
  assert.equal(replyShareVerdict63({ ...local16k, reasoningBudget: 4000,
    reservedForReply: 5024, usageReserve: 5024, drawn: 4096 }).agent, false);
});

test('no preview route: nothing to compare, both pass', () => {
  assert.deepEqual(replyShareVerdict63({ skip: 'no preview route' }), { agent: true, port: true, portSkip: 'no preview route' });
});
