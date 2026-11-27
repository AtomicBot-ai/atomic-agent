// ATO-1741 / ATO-1744: "Sign in with ChatGPT" through the bundled agent's
// `atag login chatgpt --no-browser`, against the built output.
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../out/main/chatgpt-oauth-login.js');

const LINK = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&code_challenge=abc&state=s1';

/** A stand-in for the agent process: tests push stdout and end it. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal ?? 'default'); return true; };
  child.say = (text) => child.stdout.emit('data', Buffer.from(text));
  child.exit = (code, signal = null) => child.emit('exit', code, signal);
  return child;
}

function harness(over = {}) {
  const spawned = [];
  const opened = [];
  const runs = [];
  const timers = [];
  const deps = {
    binary: () => '/app/Resources/agent/atomic-agent',
    spawn: (bin, args) => { const c = fakeChild(); spawned.push({ bin, args, child: c }); return c; },
    run: async (args) => { runs.push(args); return over.runAnswer ? over.runAnswer(args) : { stdout: '', stderr: '' }; },
    openExternal: async (url) => { opened.push(url); },
    platform: 'darwin',
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    ...over.deps,
  };
  return { oauth: M.createChatgptOauth(deps), spawned, opened, runs, timers };
}

/** start() asks `login --help` first (ATO-2510), so the agent is spawned a moment later. */
const tick = () => new Promise((r) => setImmediate(r));

const AGENT_OUT = `ChatGPT sign-in (experimental; the Codex CLI provider stays the recommended way).\nOpen this link in a browser on this computer to sign in:\n\n${LINK}\n\nWaiting... (Ctrl+C to cancel; on another machine use --device)\n`;

test('runs `login chatgpt --no-browser` on the bundled agent, opens the link once, returns the entry id', async () => {
  const h = harness();
  const pending = h.oauth.start();
  await tick();
  const { bin, args, child } = h.spawned[0];
  assert.equal(bin, '/app/Resources/agent/atomic-agent');
  assert.deepEqual(args, ['login', 'chatgpt', '--no-browser']);
  // The link arrives in two pieces: nothing opens until it is whole.
  child.say(AGENT_OUT.slice(0, AGENT_OUT.indexOf('state=')));
  assert.equal(h.opened.length, 0);
  child.say(AGENT_OUT.slice(AGENT_OUT.indexOf('state=')));
  assert.deepEqual(h.opened, [LINK]);
  child.say('Signed in (ChatGPT plus).\nAdded provider "chatgpt-sub" (ChatGPT subscription, experimental), model gpt-5.1-codex.\nTo use it, pick "chatgpt-sub" in the Providers panel.\n');
  child.exit(0);
  const r = await pending;
  assert.deepEqual(r, { ok: true, state: 'signed_in', providerId: 'chatgpt-sub' });
  // Only these keys reach the window: no link, no output.
  assert.equal(JSON.stringify(r).includes('auth.openai.com'), false);
  assert.equal(h.oauth.running(), false);
});

test('a reused entry ("Provider ... now uses this sign-in") is returned too', () => {
  assert.equal(M.providerIdIn('Provider "chatgpt-sub-2" now uses this sign-in.\n'), 'chatgpt-sub-2');
  assert.equal(M.providerIdIn('Signed in.\n'), undefined);
});

test('a second start while one runs joins it and spawns nothing', async () => {
  const h = harness();
  const a = h.oauth.start();
  const b = h.oauth.start();
  await tick();
  assert.equal(a, b);
  assert.equal(h.spawned.length, 1);
  h.spawned[0].child.exit(0);
  await a;
  // After it ended, a new start is a new process.
  h.oauth.start();
  await tick();
  assert.equal(h.spawned.length, 2);
});

test('a link for any other host is never opened and the sign-in stops', async () => {
  for (const bad of [
    'https://auth.openai.com.evil.example/oauth/authorize?state=x',
    'https://evil.example/oauth/authorize?state=x',
    'http://auth.openai.com/oauth/authorize?state=x',
  ]) {
    const h = harness();
    const pending = h.oauth.start();
    await tick();
    const { child } = h.spawned[0];
    child.say(`Open this link:\n\n${bad}\n\n`);
    assert.deepEqual(h.opened, [], bad);
    assert.deepEqual(child.kills, ['SIGINT'], bad);
    child.exit(1);
    assert.deepEqual(await pending, { ok: false, state: 'failed', reason: 'failed' });
  }
  assert.equal(M.authorizationUrlIn(`${LINK}\n`), LINK);
  assert.equal(M.authorizationUrlIn('https://auth.openai.com:8443/oauth/authorize?x=1\n'), null);
});

test('cancel sends SIGINT on macOS and Linux, a plain kill on Windows; the reason is cancelled', async () => {
  for (const [platform, expected] of [['darwin', ['SIGINT']], ['linux', ['SIGINT']], ['win32', ['default']]]) {
    const h = harness({ deps: { platform } });
    const pending = h.oauth.start();
    await tick();
    const { child } = h.spawned[0];
    assert.equal(h.oauth.cancel(), true);
    assert.deepEqual(child.kills, expected, platform);
    // Windows: killed outright, no exit code. Elsewhere the agent says it was cancelled.
    if (platform === 'win32') child.exit(null, 'SIGTERM');
    else { child.say('Sign-in cancelled.\n'); child.exit(1); }
    assert.deepEqual(await pending, { ok: false, state: 'failed', reason: 'cancelled' });
  }
  assert.equal(harness().oauth.cancel(), false);
});

test('an agent that ignores SIGINT is killed hard after a grace period', async () => {
  const h = harness();
  h.oauth.start();
  await tick();
  const { child } = h.spawned[0];
  h.oauth.cancel();
  const grace = h.timers.find((t) => t.ms === 5000);
  assert.ok(grace);
  grace.fn();
  assert.deepEqual(child.kills, ['SIGINT', 'SIGKILL']);
});

test('the backstop timer stops the sign-in with reason timeout', async () => {
  const h = harness();
  const pending = h.oauth.start();
  await tick();
  const { child } = h.spawned[0];
  const backstop = h.timers.find((t) => t.ms === M.LOGIN_TIMEOUT_MS);
  backstop.fn();
  child.exit(null, 'SIGINT');
  assert.deepEqual(await pending, { ok: false, state: 'failed', reason: 'timeout' });
});

test('the reason comes from the agent\'s own fixed sentences', async () => {
  const cases = [
    ['Sign-in timed out: the browser never came back. Try again, or use --device.\n', 'timeout'],
    ['Signed in, but the token names no ChatGPT account. A ChatGPT plan (Plus, Pro, Team, ...) is needed.\n', 'no_account'],
    ['Sign-in cancelled.\n', 'cancelled'],
    ['Ports 1455 and 1457 are both in use (another sign-in still open?).\n', 'failed'],
  ];
  for (const [said, reason] of cases) {
    const h = harness();
    const pending = h.oauth.start();
    await tick();
    h.spawned[0].child.say(said);
    h.spawned[0].child.exit(1);
    assert.deepEqual(await pending, { ok: false, state: 'failed', reason }, said);
  }
});

test('no agent binary, a spawn error or a failed browser open is a plain failure', async () => {
  assert.deepEqual(await harness({ deps: { binary: () => null } }).oauth.start(), { ok: false, state: 'failed', reason: 'failed' });
  const h = harness();
  const pending = h.oauth.start();
  await tick();
  h.spawned[0].child.emit('error', new Error('ENOENT'));
  assert.deepEqual(await pending, { ok: false, state: 'failed', reason: 'failed' });

  const h2 = harness({ deps: { openExternal: async () => { throw new Error('no browser'); } } });
  const p2 = h2.oauth.start();
  await tick();
  h2.spawned[0].child.say(AGENT_OUT);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h2.spawned[0].child.kills, ['SIGINT']);
  h2.spawned[0].child.exit(1);
  assert.deepEqual(await p2, { ok: false, state: 'failed', reason: 'failed' });
});

/* ------------------------------------------------------------ ATO-1744 */

const NEW_HELP = 'Usage: atomic-agent login chatgpt [--device] [--no-browser]\n       atomic-agent login copilot\n       atomic-agent login status [copilot] [--json]\n';
const OLD_HELP = 'unknown command: login\n';

test('supported: the new agent\'s help lists `login chatgpt`, an old one says unknown command', () => {
  assert.equal(M.helpHasChatgptLogin(NEW_HELP), true);
  assert.equal(M.helpHasChatgptLogin(OLD_HELP), false);
  assert.equal(M.helpHasChatgptLogin(''), false);
});

test('supported is asked once per run and cached', async () => {
  const h = harness({ runAnswer: (args) => (args[1] === '--help' ? { stdout: NEW_HELP, stderr: '' } : { stdout: '{"signedIn":false,"plan":null}', stderr: '' }) });
  assert.equal(await h.oauth.supported(), true);
  assert.equal(await h.oauth.supported(), true);
  await h.oauth.status();
  assert.equal(h.runs.filter((a) => a[1] === '--help').length, 1);
});

test('status: only signed-in, plan and supported; an old agent is not asked for status', async () => {
  const report = JSON.stringify({ service: 'chatgpt', experimental: true, signedIn: true, plan: 'plus', accessTokenExpiresAt: 1, canRenew: true, tokenFile: '/Users/me/.atomic-agent/auth/chatgpt.json' }, null, 2);
  const h = harness({ runAnswer: (args) => (args[1] === '--help' ? { stdout: NEW_HELP, stderr: '' } : { stdout: `${report}\n`, stderr: '' }) });
  assert.deepEqual(await h.oauth.status(), { ok: true, signedIn: true, plan: 'plus', supported: true });
  assert.deepEqual(h.runs.at(-1), ['login', 'status', '--json']);

  const old = harness({ runAnswer: () => ({ stdout: '', stderr: OLD_HELP }) });
  assert.deepEqual(await old.oauth.status(), { ok: true, signedIn: false, plan: null, supported: false });
  assert.equal(old.runs.length, 1);
});

test('parseLoginStatus reads garbage as not signed in', () => {
  assert.deepEqual(M.parseLoginStatus('not json'), { signedIn: false, plan: null });
  assert.deepEqual(M.parseLoginStatus('{"signedIn":"yes","plan":"<b>x</b>"}'), { signedIn: false, plan: null });
});
