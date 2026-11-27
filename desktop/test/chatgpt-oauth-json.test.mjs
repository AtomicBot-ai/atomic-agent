// ATO-2510: "Sign in with ChatGPT" reads `atag login chatgpt --json` when the
// bundled agent has it, and the old sentence matching stays for older agents.
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const E = require('../out/main/chatgpt-oauth-events.js');
const M = require('../out/main/chatgpt-oauth-login.js');

const LINK = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&state=s1';
const JSON_HELP = 'Usage: atomic-agent login chatgpt [--device] [--no-browser] [--json]\n       atomic-agent login copilot\n       atomic-agent login status [copilot] [--json]\n';
const TEXT_HELP = 'Usage: atomic-agent login chatgpt [--device] [--no-browser]\n       atomic-agent login copilot\n       atomic-agent login status [copilot] [--json]\n';
const line = (o) => `${JSON.stringify(o)}\n`;
const tick = () => new Promise((r) => setImmediate(r));

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal ?? 'default'); return true; };
  child.say = (text) => child.stdout.emit('data', Buffer.from(text));
  child.exit = (code, signal = null) => child.emit('exit', code, signal);
  return child;
}

function harness(help = JSON_HELP) {
  const spawned = [];
  const opened = [];
  const oauth = M.createChatgptOauth({
    binary: () => '/app/agent',
    spawn: (bin, args) => { const c = fakeChild(); spawned.push({ args, child: c }); return c; },
    run: async () => ({ stdout: help, stderr: '' }),
    openExternal: async (url) => { opened.push(url); },
    platform: 'darwin',
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  return { oauth, spawned, opened };
}

test('the help probe: --json only counts on the `login chatgpt` line', () => {
  assert.equal(E.helpHasLoginJson(JSON_HELP), true);
  // `login status ... [--json]` is on another line: an agent before ATO-2510.
  assert.equal(E.helpHasLoginJson(TEXT_HELP), false);
  assert.equal(E.helpHasLoginJson('unknown command: login\n'), false);
});

test('parses each event the wizard uses and skips everything else', () => {
  assert.deepEqual(E.parseLoginJsonLine(JSON.stringify({ type: 'authorization_url', url: LINK, opened: false })), { type: 'authorization_url', url: LINK });
  assert.deepEqual(E.parseLoginJsonLine('{"type":"signed_in","providerId":"chatgpt-sub","providerAdded":true}'), { type: 'signed_in', providerId: 'chatgpt-sub' });
  assert.deepEqual(E.parseLoginJsonLine('{"type":"signed_in","providerId":"<b>bad id</b>"}'), { type: 'signed_in' });
  for (const reason of ['timeout', 'no_account', 'cancelled', 'failed']) {
    assert.deepEqual(E.parseLoginJsonLine(JSON.stringify({ type: 'error', reason, message: 'x' })), { type: 'error', reason });
  }
  assert.deepEqual(E.parseLoginJsonLine('{"type":"error","reason":"something new"}'), { type: 'error', reason: 'failed' });
  assert.equal(E.parseLoginJsonLine('{"type":"notice","message":"hi"}'), null);
  assert.equal(E.parseLoginJsonLine('{"type":"device_code","userCode":"AB-12"}'), null);
  assert.equal(E.parseLoginJsonLine('Signed in.'), null);
  assert.equal(E.parseLoginJsonLine('null'), null);
});

test('a link for any other host parses as url: null', () => {
  for (const bad of [
    'https://auth.openai.com.evil.example/oauth/authorize?x=1',
    'http://auth.openai.com/oauth/authorize?x=1',
    'https://auth.openai.com:8443/oauth/authorize?x=1',
    'https://auth.openai.com/elsewhere?x=1',
    42,
  ]) {
    assert.deepEqual(E.parseLoginJsonLine(JSON.stringify({ type: 'authorization_url', url: bad })), { type: 'authorization_url', url: null }, String(bad));
  }
});

test('the reader joins a line split across chunks', () => {
  const r = E.createLoginJsonReader();
  const whole = line({ type: 'signed_in', providerId: 'chatgpt-sub' });
  assert.deepEqual(r.push(whole.slice(0, 10)), []);
  assert.deepEqual(r.push(whole.slice(10)), [{ type: 'signed_in', providerId: 'chatgpt-sub' }]);
});

test('an agent with --json: spawned with it, opens the link, returns the provider id from signed_in', async () => {
  const h = harness();
  const pending = h.oauth.start();
  await tick();
  const { args, child } = h.spawned[0];
  assert.deepEqual(args, ['login', 'chatgpt', '--no-browser', '--json']);
  const urlLine = line({ type: 'authorization_url', url: LINK, opened: false });
  child.say(urlLine.slice(0, 30));
  assert.deepEqual(h.opened, []);
  child.say(urlLine.slice(30));
  assert.deepEqual(h.opened, [LINK]);
  // Reworded sentences do not matter any more: only the JSON is read.
  child.say(line({ type: 'notice', message: 'Provider "decoy" whatever.' }));
  child.say(line({ type: 'signed_in', providerId: 'chatgpt-sub-2', providerAdded: false, model: 'm', modelSource: 'backend', plan: 'plus' }));
  child.exit(0);
  assert.deepEqual(await pending, { ok: true, state: 'signed_in', providerId: 'chatgpt-sub-2' });
});

test('an agent with --json: the error line gives the reason', async () => {
  for (const reason of ['timeout', 'no_account', 'cancelled', 'failed']) {
    const h = harness();
    const pending = h.oauth.start();
    await tick();
    h.spawned[0].child.say(line({ type: 'error', reason, message: 'Some reworded sentence.' }));
    h.spawned[0].child.exit(1);
    assert.deepEqual(await pending, { ok: false, state: 'failed', reason }, reason);
  }
});

test('an agent with --json: a link for another host is never opened and the sign-in stops', async () => {
  const h = harness();
  const pending = h.oauth.start();
  await tick();
  const { child } = h.spawned[0];
  child.say(line({ type: 'authorization_url', url: 'https://evil.example/oauth/authorize?x=1', opened: false }));
  assert.deepEqual(h.opened, []);
  assert.deepEqual(child.kills, ['SIGINT']);
  child.exit(1);
  assert.deepEqual(await pending, { ok: false, state: 'failed', reason: 'failed' });
});

test('an older agent without --json keeps the sentence matching', async () => {
  const h = harness(TEXT_HELP);
  const pending = h.oauth.start();
  await tick();
  const { args, child } = h.spawned[0];
  assert.deepEqual(args, ['login', 'chatgpt', '--no-browser']);
  child.say(`Open this link in a browser on this computer to sign in:\n\n${LINK}\n\n`);
  assert.deepEqual(h.opened, [LINK]);
  child.say('Signed in.\nProvider "chatgpt-sub" now uses this sign-in.\n');
  child.exit(0);
  assert.deepEqual(await pending, { ok: true, state: 'signed_in', providerId: 'chatgpt-sub' });
});

test('a cancel while the help probe runs spawns nothing', async () => {
  const h = harness();
  const pending = h.oauth.start();
  assert.equal(h.oauth.cancel(), true);
  assert.deepEqual(await pending, { ok: false, state: 'failed', reason: 'cancelled' });
  await tick();
  assert.equal(h.spawned.length, 0);
  assert.equal(h.oauth.running(), false);
});
