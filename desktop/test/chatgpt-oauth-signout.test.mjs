// ATO-2511: Settings › Models' Sign out on the ChatGPT sign-in provider runs
// the bundled agent's `atag logout chatgpt` (main/chatgpt-oauth-signout.ts),
// against the built output.
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../out/main/chatgpt-oauth-signout.js');

/** The agent's own sentences (src/cli/login-command.ts logoutCommand). */
const SIGNED_OUT = 'Signed out of ChatGPT (experimental). The stored sign-in was deleted.\n';
const NOTHING = 'Not signed in to ChatGPT; nothing to delete.\n';
const FAILED = 'Could not delete /Users/me/.atomic-agent/auth/chatgpt.json. Delete it by hand to sign out.\n';

test('runs exactly `logout chatgpt` with a short timeout', async () => {
  const runs = [];
  const r = await M.chatgptSignOut({ run: async (args, ms) => { runs.push([args, ms]); return { ok: true, stdout: SIGNED_OUT, stderr: '' }; } });
  assert.deepEqual(runs, [[['logout', 'chatgpt'], M.SIGN_OUT_TIMEOUT_MS]]);
  assert.ok(M.SIGN_OUT_TIMEOUT_MS <= 30_000);
  assert.deepEqual(r, { ok: true, state: 'signed_out', hadSignIn: true });
});

test('nothing stored is still a signed-out end', () => {
  assert.deepEqual(M.parseSignOut({ stdout: NOTHING, stderr: '' }), { ok: true, state: 'signed_out', hadSignIn: false });
});

test('a failed delete is failed, and the agent words go only to detail', () => {
  const r = M.parseSignOut({ ok: false, stdout: FAILED, stderr: '', error: 'exit 1' });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'failed');
  assert.equal(r.reason, 'failed');
  assert.match(r.detail, /Could not delete/);
  assert.equal(Object.keys(r).sort().join(','), 'detail,ok,reason,state');
});

test('an agent without logout says unknown command: unsupported', () => {
  const r = M.parseSignOut({ ok: false, stdout: '', stderr: 'unknown command "logout"\n' });
  assert.equal(r.reason, 'unsupported');
});

test('a run that throws is failed, never a throw', async () => {
  const r = await M.chatgptSignOut({ run: async () => { throw new Error('spawn ENOENT'); } });
  assert.deepEqual(r, { ok: false, state: 'failed', reason: 'failed', detail: 'spawn ENOENT' });
});

test('a long output is cut for Details', () => {
  const r = M.parseSignOut({ stdout: 'x'.repeat(5000), stderr: '' });
  assert.ok(r.detail.length <= 400);
});

test('the IPC route and the bridge are wired, and a running sign-in is stopped first', () => {
  const ipc = readFileSync(new URL('../main/chatgpt-oauth-ipc.ts', import.meta.url), 'utf8');
  const handler = ipc.slice(ipc.indexOf('ipcMain.handle("chatgptOauth:signOut"'));
  assert.ok(handler.length > 0);
  assert.ok(handler.indexOf('oauth.cancel()') > 0 && handler.indexOf('oauth.cancel()') < handler.indexOf('chatgptSignOut('));
  const preload = readFileSync(new URL('../preload/preload.ts', import.meta.url), 'utf8');
  assert.match(preload, /chatgptOauthSignOut: \(\) => ipcRenderer\.invoke\("chatgptOauth:signOut"\)/);
});
