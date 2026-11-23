import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);

// An empty state folder: resolveKeyValue also reads <stateDir>/.env and the keychain
// cache, and the real ~/.atomic-agent must not decide these answers.
const stateDir = mkdtempSync(join(tmpdir(), 'ato1703-state-'));
process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
process.on('exit', () => rmSync(stateDir, { recursive: true, force: true }));

// ATO-1703: the shared OpenAI key only goes to OpenAI itself or this machine,
// the same rule as the agent's resolve-llm-api-key.ts.
const SHARED = ['OPENAI_COMPAT_API_KEY', 'OPENAI_API_KEY', 'ATOMIC_AGENT_OPENAI_API_KEY'];

function withEnv(vars, fn) {
  const saved = Object.fromEntries(SHARED.map((n) => [n, process.env[n]]));
  for (const n of SHARED) delete process.env[n];
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

async function withEnvAsync(vars, fn) {
  const saved = Object.fromEntries(SHARED.map((n) => [n, process.env[n]]));
  for (const n of SHARED) delete process.env[n];
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const compat = (baseUrl) => ({id: 'custom', kind: 'openai-compatible', ...(baseUrl === undefined ? {} : {baseUrl})});

test('mayReceiveOpenAiKey: OpenAI, this machine or no address only', () => {
  const { mayReceiveOpenAiKey } = require('../out/main/agent-cli.js');
  for (const url of [undefined, '', 'https://api.openai.com', 'https://API.openai.com/v1/', 'http://127.0.0.1:8080', 'http://127.0.0.2:8080', 'http://localhost:1234', 'http://[::1]:1']) {
    assert.equal(mayReceiveOpenAiKey(url), true, String(url));
  }
  for (const url of ['https://llm.example.com', 'https://api.openai.com.evil.example', 'https://api.openai.com@evil.example', 'http://api.openai.com', 'https://api.openai.com:8443', 'http://box.localhost:1', 'http://0.0.0.0:8080', 'not a url']) {
    assert.equal(mayReceiveOpenAiKey(url), false, url);
  }
});

test('a server a config file named does not get OPENAI_API_KEY, and the app does not count it as a key', () => {
  const { resolveKeyValue, providerHasKey } = require('../out/main/agent-cli.js');
  withEnv({OPENAI_API_KEY: 'sk-real'}, () => {
    assert.equal(resolveKeyValue(compat('https://llm.example.com')), null);
    assert.equal(providerHasKey(compat('https://llm.example.com'),
      {present: new Set(['OPENAI_API_KEY']), nonEmpty: new Set(['OPENAI_API_KEY']), badChars: new Set()}), false);
    assert.equal(resolveKeyValue(compat('https://api.openai.com')), 'sk-real');
    assert.equal(resolveKeyValue(compat('http://127.0.0.1:8080')), 'sk-real');
    assert.equal(resolveKeyValue(compat()), 'sk-real');
  });
  withEnv({ATOMIC_AGENT_OPENAI_API_KEY: 'sk-real'}, () => {
    assert.equal(resolveKeyValue(compat('https://llm.example.com')), null);
  });
});

test('OPENAI_COMPAT_API_KEY still works for any compat server', () => {
  const { resolveKeyValue, providerHasKey } = require('../out/main/agent-cli.js');
  withEnv({OPENAI_COMPAT_API_KEY: 'compat-key', OPENAI_API_KEY: 'sk-real'}, () => {
    assert.equal(resolveKeyValue(compat('https://llm.example.com')), 'compat-key');
    assert.equal(providerHasKey(compat('https://llm.example.com'),
      {present: new Set(['OPENAI_COMPAT_API_KEY']), nonEmpty: new Set(['OPENAI_COMPAT_API_KEY']), badChars: new Set()}), true);
  });
});

test('the renderer and the Settings smoke use the same rule', () => {
  const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  const at = renderer.indexOf('\nfunction llmKeyEnvNames(');
  const fnSrc = renderer.slice(at + 1, renderer.indexOf('\n}\n', at) + 2);
  const c = {URL};
  runInNewContext(fnSrc, c);
  assert.deepEqual(Array.from(c.llmKeyEnvNames(compat('https://llm.example.com'))), ['OPENAI_COMPAT_API_KEY']);
  assert.deepEqual(Array.from(c.llmKeyEnvNames(compat('https://api.openai.com'))), SHARED);
  assert.deepEqual(Array.from(c.llmKeyEnvNames(compat('http://localhost:1234/v1'))), SHARED);
  assert.deepEqual(Array.from(c.llmKeyEnvNames(compat())), SHARED);
  const main = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
  const k = main.indexOf('const keyNames = (p: Provider)');
  assert.match(main.slice(k, main.indexOf(': [];', k)), /sharedCompatKeyNames\(p\)/);
});

test('naming OPENAI_API_KEY as the entry\'s own variable is no way around the rule', () => {
  const { resolveKeyValue, providerHasKey, providerKeyInvalid } = require('../out/main/agent-cli.js');
  const names = {present: new Set(['OPENAI_API_KEY']), nonEmpty: new Set(['OPENAI_API_KEY']), badChars: new Set(['OPENAI_API_KEY'])};
  withEnv({OPENAI_API_KEY: 'sk-real'}, () => {
    const evil = {...compat('https://evil.example'), apiKeyEnvVar: 'OPENAI_API_KEY'};
    assert.equal(resolveKeyValue(evil), null);
    assert.equal(providerHasKey(evil, names), false);
    assert.equal(providerKeyInvalid(evil, names), false);
    assert.equal(resolveKeyValue({id: 'or', kind: 'openrouter', apiKeyEnvVar: 'OPENAI_API_KEY'}), null);
    assert.equal(resolveKeyValue({...compat('https://api.openai.com'), apiKeyEnvVar: 'OPENAI_API_KEY'}), 'sk-real');
  });
});

test('an entry\'s own variable is authoritative: no fallback to the shared ones', () => {
  const { resolveKeyValue } = require('../out/main/agent-cli.js');
  withEnv({OPENAI_COMPAT_API_KEY: 'compat-key'}, () => {
    assert.equal(resolveKeyValue({...compat('https://llm.example.com'), apiKeyEnvVar: 'ATO1703_UNSET_KEY'}), null);
  });
});

test('the codex billing warning still sees OPENAI_API_KEY (subscription-cli, no address)', async () => {
  const { providerKeyPresent } = require('../out/main/agent-cli.js');
  await withEnvAsync({OPENAI_API_KEY: 'sk-real'}, async () => {
    const r = await providerKeyPresent({kind: 'subscription-cli', apiKeyEnvVar: 'OPENAI_API_KEY'});
    assert.deepEqual(r, {ok: true, present: true});
  });
});

test('Settings smoke keyNames gates an entry\'s own OpenAI variable', () => {
  const src = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
  assert.match(src, /p\.apiKeyEnvVar \? \(mayUseKeyVariable\(p, p\.apiKeyEnvVar\)/);
});
