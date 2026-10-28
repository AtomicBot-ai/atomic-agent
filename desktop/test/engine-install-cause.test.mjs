import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.ATOMIC_AGENT_BIN = '/nonexistent/atag-for-engine-install-cause-test';
const require = createRequire(import.meta.url);
const { updateFailureCause } = require('../out/main/agent-cli.js');

/* ATO-1233: the engine install card shows the agent's reason, not "exited with code 1". */
test('the reason line wins over the version lines around it', () => {
  const stderr = [
    'current: Atomic Core 0.18.6 → latest 0.18.6; 0.19.1 needs a newer Agent build',
    'Atomic Core version, protocol or ownership changed. Reconnect before continuing.',
    '',
  ].join('\n');
  assert.equal(updateFailureCause(stderr), 'Atomic Core version, protocol or ownership changed. Reconnect before continuing.');
});

test('log prefixes are dropped; with no reason-like line the last line is said', () => {
  assert.equal(updateFailureCause('[atomic-agent] Error: Stop local models before updating the engine.\n'), 'Stop local models before updating the engine.');
  assert.equal(updateFailureCause('something odd happened\n'), 'something odd happened');
  assert.equal(updateFailureCause('\n\n'), null);
});

test('a very long line is cut', () => {
  assert.equal(updateFailureCause('failed ' + 'x'.repeat(400)).length, 300);
});
