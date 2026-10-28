import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../out/main/remote-agent.js');

/** ATO-1127: the saved address of an agent on another computer, and its key sealed by the keychain. */
const box = (available = true) => ({
  available: () => available,
  seal: (p) => Buffer.from('sealed:' + p).toString('base64'),
  open: (s) => Buffer.from(s, 'base64').toString().replace(/^sealed:/, ''),
});

test('an address is a plain http(s) origin', () => {
  assert.equal(R.cleanRemoteUrl('http://192.168.1.20:8787'), 'http://192.168.1.20:8787');
  assert.equal(R.cleanRemoteUrl(' https://agent.example.com/ '), 'https://agent.example.com');
  assert.equal(R.cleanRemoteUrl('ftp://x'), null);
  assert.equal(R.cleanRemoteUrl('http://user:pw@x:1'), null);
  assert.equal(R.cleanRemoteUrl('http://x:1/api?y=1'), null);
  assert.equal(R.cleanRemoteUrl('not a url'), null);
});

test('saved with a sealed key, read back, cleared', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-agent-'));
  assert.equal(R.writeRemoteAgent(dir, box(), { url: 'http://10.0.0.5:8787', token: 'k'.repeat(24) }), true);
  const raw = readFileSync(join(dir, 'remote-agent.json'), 'utf8');
  assert.ok(!raw.includes('k'.repeat(24)), 'the key is not on disk in clear');
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'remote-agent.json')).mode & 0o777, 0o600);
  assert.deepEqual(R.readRemoteAgent(dir, box()), { url: 'http://10.0.0.5:8787', token: 'k'.repeat(24) });
  R.writeRemoteAgent(dir, box(), null);
  assert.equal(R.readRemoteAgent(dir, box()), null);
});

test('no keychain: nothing is saved, nothing is read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-agent-'));
  assert.equal(R.writeRemoteAgent(dir, box(false), { url: 'http://10.0.0.5:8787', token: 'x' }), false);
  assert.equal(R.readRemoteAgent(dir, box(false)), null);
});
