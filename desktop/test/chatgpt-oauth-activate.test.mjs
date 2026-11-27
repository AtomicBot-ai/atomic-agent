import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ATOMIC_AGENT_STATE_DIR = mkdtempSync(join(tmpdir(), 'chatgpt-oauth-activate-'));

const require = createRequire(import.meta.url);
const { withSwitchStandIn, activateProvider } = require('../out/main/backend-switch.js');
const { providerIsUsable, providerKeyInvalid } = require('../out/main/agent-cli.js');

/**
 * ATO-1747: `atomic-agent login chatgpt` (src/cli/login-command.ts) writes
 * `{ id, kind: "subscription-oauth", subscriptionOauth: { service: "chatgpt" }, defaultChatModel }`
 * with no key field: the saved sign-in is what the agent sends. The wizard then
 * activates it, and the switch must not refuse it as "no key".
 */
const CHATGPT = { id: 'chatgpt', kind: 'subscription-oauth', subscriptionOauth: { service: 'chatgpt' }, defaultChatModel: 'gpt-5.5' };

function fixture(active, providers) {
  let config = { llm: { activeTextProvider: active, providers } };
  const said = stdout => ({ ok: true, stdout, stderr: '' });
  const answer = async (args, input) => {
    switch (args.slice(0, 2).join(' ')) {
      case 'config get': return said(JSON.stringify(config));
      case 'config set': config = JSON.parse(input); return said('');
      case 'models status': return said('mode: managed\ndaemon: stopped\nhealth: down\n');
      default: throw new Error(`Unexpected fixture command: ${args.join(' ')}`);
    }
  };
  return {
    get config() { return config; },
    run: body => withSwitchStandIn(answer, body, { configHint: () => config, daemonPidAlive: () => false, tell: () => {} }),
  };
}

test('a ChatGPT sign-in entry counts as usable and never as a bad key', () => {
  const names = { present: new Set(), nonEmpty: new Set(), badChars: new Set() };
  assert.equal(providerIsUsable(CHATGPT, names), true);
  assert.equal(providerKeyInvalid(CHATGPT, names), false);
});

test('activating the ChatGPT sign-in entry from another cloud provider succeeds', { timeout: 5000 }, async () => {
  const f = fixture('cloud', [
    { id: 'cloud', kind: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', defaultChatModel: 'm' },
    CHATGPT,
  ]);
  const res = await f.run(() => activateProvider('chatgpt'));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.needsKey, undefined);
  assert.equal(f.config.llm.activeTextProvider, 'chatgpt');
});

test('activating the ChatGPT sign-in entry the agent already made active succeeds', { timeout: 5000 }, async () => {
  const f = fixture('chatgpt', [CHATGPT]);
  const res = await f.run(() => activateProvider('chatgpt'));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.needsKey, undefined);
  assert.equal(f.config.llm.activeTextProvider, 'chatgpt');
});
