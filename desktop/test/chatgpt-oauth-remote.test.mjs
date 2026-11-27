// ATO-2512: "Sign in with ChatGPT" while the app drives an agent on another
// computer: main answers "remote" and runs nothing on this computer
// (main/chatgpt-oauth-remote.ts, main/chatgpt-oauth-ipc.ts), against the built output.
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../out/main/chatgpt-oauth-remote.js');

test('the remote answers: status says remote, start and sign-out are refused as remote', () => {
  assert.deepEqual(M.remoteStatus(), { ok: true, signedIn: false, plan: null, supported: true, remote: true });
  assert.deepEqual(M.remoteRefusal(), { ok: false, state: 'failed', reason: 'remote' });
  assert.notEqual(M.remoteStatus(), M.remoteStatus(), 'a fresh object each time');
});

test('unlessRemote runs only the side that applies', () => {
  let local = 0, remote = 0;
  assert.equal(M.unlessRemote(() => true, () => { remote++; return 'r'; }, () => { local++; return 'l'; }), 'r');
  assert.equal(M.unlessRemote(() => false, () => { remote++; return 'r'; }, () => { local++; return 'l'; }), 'l');
  assert.equal(M.unlessRemote(undefined, () => { remote++; return 'r'; }, () => { local++; return 'l'; }), 'l', 'no isRemote: this computer');
  assert.deepEqual([local, remote], [2, 1]);
});

test('every route checks remote before it runs the bundled agent, and main.ts passes the client', () => {
  const ipc = readFileSync(new URL('../main/chatgpt-oauth-ipc.ts', import.meta.url), 'utf8');
  const route = (name) => ipc.slice(ipc.indexOf('ipcMain.handle("chatgptOauth:' + name + '"'), ipc.indexOf('});', ipc.indexOf('ipcMain.handle("chatgptOauth:' + name + '"')) + 3);
  const start = route('start');
  assert.ok(start.indexOf('deps.isRemote?.() === true) return remoteRefusal()') > 0);
  assert.ok(start.indexOf('remoteRefusal()') < start.indexOf('oauth.start()'));
  const signOut = route('signOut');
  assert.ok(signOut.indexOf('remoteRefusal()') > 0 && signOut.indexOf('remoteRefusal()') < signOut.indexOf('chatgptSignOut('));
  assert.match(ipc, /"chatgptOauth:status", \(\) => unlessRemote\(deps\.isRemote, remoteStatus, \(\) => oauth\.status\(\)\)\)/);
  const main = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
  assert.match(main, /wireChatgptOauthIpc\(\{ isRemote: \(\) => client\.isRemote \}\)/);
});
