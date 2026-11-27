// Unit tests for main/agent-jobs.ts (ATO-2485), against the built output.
// Run: npm run build && npm run test:unit
// What the window may ask of the agent's shell jobs, and the agent's
// refusals in the terminal panel's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const J = require('../out/main/agent-jobs.js');

test('a job is addressed by a chat id and a whole job number from 1', () => {
  assert.deepEqual(J.agentJobAddressOf({sessionId: 's-1', jobId: 2}), {sessionId: 's-1', jobId: 2});
  assert.equal(J.agentJobAddressOf({sessionId: 's-1', jobId: 0}), null);
  assert.equal(J.agentJobAddressOf({sessionId: 's-1', jobId: 1.5}), null);
  assert.equal(J.agentJobAddressOf({sessionId: 'a/b', jobId: 1}), null);
  assert.equal(J.agentJobAddressOf(null), null);
});

test('a bad position reads from the start', () => {
  assert.equal(J.agentJobSinceOf(12), 12);
  assert.equal(J.agentJobSinceOf(-1), 0);
  assert.equal(J.agentJobSinceOf('5'), 0);
});

test('input: text or end of input, within the agent cap', () => {
  assert.deepEqual(J.agentJobInputOf({sessionId: 's', jobId: 1, text: 'y\n', eof: false}),
    {ok: true, address: {sessionId: 's', jobId: 1}, text: 'y\n', eof: false});
  assert.equal(J.agentJobInputOf({sessionId: 's', jobId: 1, text: '', eof: true}).ok, true);
  assert.equal(J.agentJobInputOf({sessionId: 's', jobId: 1, text: ''}).ok, false);
  assert.equal(J.agentJobInputOf({sessionId: 's', jobId: 1, text: 'x'.repeat(J.AGENT_JOB_INPUT_MAX_CHARS + 1)}).ok, false);
  assert.equal(J.agentJobInputOf({sessionId: 's', jobId: 1, text: 3}).ok, false);
});

test('refusals in plain words; an older agent is marked unsupported', () => {
  assert.deepEqual(J.agentJobErrorOf(new Error('No route for GET /api/sessions/s/shell-jobs')).unsupported, true);
  assert.match(J.agentJobErrorOf(new Error('no job 3 in session s')).error, /ended/);
  assert.match(J.agentJobErrorOf(new Error('job 3 does not take input: …')).error, /doesn't take typing/);
  const other = J.agentJobErrorOf(new Error('ECONNREFUSED 127.0.0.1:1234'));
  assert.equal(other.unsupported, false);
  // No raw error text or address reaches the person.
  assert.doesNotMatch(other.error, /ECONNREFUSED|127\.0\.0\.1/);
});

test('a terminal size is two whole numbers the agent takes', () => {
  assert.deepEqual(J.agentJobSizeOf({cols: 120, rows: 40}), {cols: 120, rows: 40});
  assert.equal(J.agentJobSizeOf({cols: 1, rows: 40}), null);
  assert.equal(J.agentJobSizeOf({cols: 120.5, rows: 40}), null);
  assert.equal(J.agentJobSizeOf({}), null);
});
