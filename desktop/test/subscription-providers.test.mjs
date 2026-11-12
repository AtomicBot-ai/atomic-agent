// ATO-844: Add provider offers Claude Code and Codex again, with the TUI's
// labels (#710), and saves them as the TUI's wizard does. renderer.js is read
// as text and the pieces run in a vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
function slice(start, end) {
  const i = renderer.indexOf(start);
  assert.ok(i >= 0, start);
  const j = renderer.indexOf(end, i);
  assert.ok(j > i, end);
  return renderer.slice(i, j);
}

function load(present, status) {
  const asked = [];
  const statusAsked = [];
  const ctx = createContext({
    THIS_MACHINE: 'this Mac',
    WIZ: { row: null },
    navigator: { platform: 'MacIntel' },
    render() {},
    BR: {
      providerKeyPresent: (q) => { asked.push(q); return Promise.resolve({ ok: true, present }); },
      ...(status ? { subscriptionStatus: (cli) => { statusAsked.push(cli); return Promise.resolve({ ok: true, status: status(cli) }); } } : {}),
    },
  });
  runInContext(slice('const KIND_ROWS = [', '];') + '];'
    + slice('function wizService(row)', '\n') + '\n'
    + slice('const WIZ_BILLING = new Map();', 'async function wizSubscriptionStep(k)')
    + ';this.rows = KIND_ROWS; this.entry = wizSubscriptionEntry; this.lines = wizSubscriptionLines; this.service = wizService; this.wizSubReady = wizSubReady; this.wizSubButton = wizSubButton;', ctx);
  return { ctx, asked, statusAsked };
}

test('both subscription rows are offered with the terminal labels, after the one-key services', () => {
  const { ctx } = load(false);
  // Arrays built in the vm belong to its realm: compare a plain copy.
  const ids = JSON.parse(JSON.stringify(ctx.rows.map((k) => k.id)));
  assert.equal(ids[0], 'openrouter', 'row 0 stays OpenRouter');
  assert.deepEqual(ids.slice(3, 5), ['claude-cli', 'codex-cli']);
  assert.equal(ctx.rows[3].label, 'Claude Code subscription: the agent runs on your plan (signed-in `claude`)');
  assert.equal(ctx.rows[4].label, 'OpenAI Codex subscription: the agent runs on your plan (signed-in `codex`)');
  assert.equal(ctx.service(ctx.rows[3]), 'Claude Code');
  assert.ok(ctx.rows[ctx.rows.length - 1].custom, 'the custom row stays last');
});

test('the saved entry is the one the TUI writes', () => {
  const { ctx } = load(false);
  const [claude, codex] = [ctx.rows[3], ctx.rows[4]];
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.entry(claude))),
    { id: 'claude-cli', kind: 'subscription-cli', subscriptionCli: { cli: 'claude' }, defaultChatModel: 'sonnet' });
  // Codex resolves its own model: no defaultChatModel at all, not "".
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.entry(codex))),
    { id: 'codex-cli', kind: 'subscription-cli', subscriptionCli: { cli: 'codex' } });
});

test('the step warns about per-token billing only when the variable is set', async () => {
  const off = load(false);
  assert.equal(off.ctx.lines(off.ctx.rows[3]).length, 1);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(off.ctx.lines(off.ctx.rows[3]).length, 1);
  assert.equal(off.asked[0].apiKeyEnvVar, 'ANTHROPIC_API_KEY');

  const on = load(true);
  on.ctx.lines(on.ctx.rows[4]);
  await new Promise((r) => setTimeout(r, 0));
  const lines = on.ctx.lines(on.ctx.rows[4]);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].warn);
  assert.match(lines[1].text, /^OPENAI_API_KEY is set/);
  assert.equal(on.asked.length, 1, 'asked once per variable');
  for (const l of lines) assert.doesNotMatch(l.text, /—/);
});

test('Next on a subscription row takes the no-key path, and both setup screens draw it', () => {
  const step = slice('async function wizNextStep()', 'const key = document.getElementById');
  assert.match(step, /if \(k\.subscriptionCli\) return wizSubscriptionStep\(k\);/);
  assert.equal(renderer.split('if (k.subscriptionCli) {').length - 1, 2, 'the popover and the first-run screens');
  const sub = slice('async function wizSubscriptionStep(k)', 'async function wizNext()');
  assert.doesNotMatch(sub, /verifyProviderKey/);
  assert.match(sub, /wizActivate\(k, id, '', null\)/, 'Codex, with no model list, is activated as it is');
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const plain = (x) => JSON.parse(JSON.stringify(x));

test('ATO-756: a missing CLI gets install steps, the button waits, nothing is run', async () => {
  const { ctx, statusAsked } = load(false, (cli) => ({ cli, installed: false, binPath: null, signedIn: false }));
  const claude = ctx.rows[3];
  ctx.lines(claude); await tick();
  const lines = plain(ctx.lines(claude));
  assert.ok(lines[0].warn);
  assert.match(lines[0].text, /Claude Code is not installed on this Mac\. To use your Claude subscription:/);
  assert.deepEqual(lines.filter((l) => l.code).map((l) => l.text), ['curl -fsSL https://claude.ai/install.sh | bash']);
  assert.match(lines.at(-1).text, /Check again/);
  assert.equal(ctx.wizSubReady(claude), false);
  assert.deepEqual(statusAsked, ['claude'], 'asked once');
  assert.equal(ctx.wizSubButton(claude), 'Use my Claude subscription');
  assert.equal(ctx.wizSubButton(ctx.rows[4]), 'Use my ChatGPT subscription');
});

test('ATO-756: installed but signed out says how to sign in; Codex on an API key says so', async () => {
  const { ctx } = load(false, (cli) => ({ cli, installed: true, binPath: null, signedIn: false, ...(cli === 'codex' ? { apiKeyLogin: true } : {}) }));
  ctx.lines(ctx.rows[3]); ctx.lines(ctx.rows[4]); await tick();
  const claude = plain(ctx.lines(ctx.rows[3]));
  assert.match(claude[0].text, /not signed in/);
  assert.deepEqual(claude.filter((l) => l.code).map((l) => l.text), ['claude']);
  const codex = plain(ctx.lines(ctx.rows[4]));
  assert.match(codex[0].text, /API key, which bills per token/);
  assert.deepEqual(codex.filter((l) => l.code).map((l) => l.text), ['codex login']);
  assert.equal(ctx.wizSubReady(ctx.rows[3]), true, 'signed-out is still allowed: the CLI may know better');
});

test('ATO-756: ready says so, and a CLI found off PATH is saved with its path', async () => {
  const { ctx } = load(false, (cli) => ({ cli, installed: true, binPath: '/Users/nadia/.local/bin/claude', signedIn: true }));
  ctx.lines(ctx.rows[3]); await tick();
  const lines = plain(ctx.lines(ctx.rows[3]));
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^Found Claude Code and you are signed in\./);
  assert.deepEqual(plain(ctx.entry(ctx.rows[3])),
    { id: 'claude-cli', kind: 'subscription-cli', subscriptionCli: { cli: 'claude', binPath: '/Users/nadia/.local/bin/claude' }, defaultChatModel: 'sonnet' });
});

test('ATO-756: Check again is a wizard verb in first run too, and Enter cannot save a missing CLI', () => {
  assert.match(renderer, /a === 'wiz:saveUnchecked' \|\| a === 'wiz:subRecheck'/);
  const sub = slice('async function wizSubscriptionStep(k)', 'async function wizNext()');
  assert.match(sub, /if \(!wizSubReady\(k\)\) \{ render\(\); return; \}/);
});

/* ATO-845: signed out, the main button is "Sign in with Claude / ChatGPT":
   it opens the terminal (main does), the step polls the login file and moves
   on through act('wiz:next') once signed in. The command with Copy stays as
   the small fallback. */
function loadLogin(statusSeq, loginResult) {
  const events = [];
  const acts = [];
  const copied = [];
  const intervals = [];
  let i = 0;
  const ctx = createContext({
    THIS_MACHINE: 'this Mac',
    WIZ: { row: null, phase: 'configure', stepping: false },
    OB: { open: false },
    navigator: { platform: 'MacIntel' },
    render() {},
    act: (a) => acts.push(a),
    copyText: (t) => { copied.push(t); return Promise.resolve(true); },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    Date,
    ANX: {
      subscriptionLoginClicked: (cli, ob) => events.push(['clicked', cli, ob]),
      subscriptionTerminalOpened: (cli, ob, opened, detail) => events.push(['terminal', cli, opened, detail]),
      subscriptionLoginSucceeded: (cli, ob, s) => events.push(['succeeded', cli, typeof s]),
    },
    BR: {
      providerKeyPresent: () => Promise.resolve({ ok: true, present: false }),
      subscriptionStatus: (cli) => Promise.resolve({ ok: true, status: { cli, ...statusSeq[Math.min(i++, statusSeq.length - 1)] } }),
      subscriptionLogin: () => Promise.resolve(loginResult),
    },
  });
  runInContext(slice('const KIND_ROWS = [', '];') + '];'
    + slice('function wizService(row)', '\n') + '\n'
    + slice('const WIZ_BILLING = new Map();', 'async function wizSubscriptionStep(k)')
    + ';this.rows = KIND_ROWS; this.lines = wizSubscriptionLines; this.needsLogin = wizSubNeedsLogin; this.loginButton = wizSubLoginButton;'
    + 'this.login = wizSubLogin; this.copy = wizSubCopy; this.lineHTML = wizSubLineHTML; this.esc = (s) => String(s);', ctx);
  ctx.esc = (s) => String(s);
  return { ctx, events, acts, copied, intervals };
}

test('ATO-845: signed out, the main button says Sign in with the plan, and Copy is the fallback', async () => {
  const out = { installed: true, binPath: null, signedIn: false };
  const { ctx, copied } = loadLogin([out], { ok: true, terminal: 'terminal_app' });
  const [claude, codex] = [ctx.rows[3], ctx.rows[4]];
  ctx.WIZ.row = codex;
  ctx.lines(claude); ctx.lines(codex); await tick();
  assert.equal(ctx.needsLogin(codex), true);
  assert.equal(ctx.loginButton(claude), 'Sign in with Claude');
  assert.equal(ctx.loginButton(codex), 'Sign in with ChatGPT');
  const lines = plain(ctx.lines(codex));
  assert.match(lines[1].text, /^Press Sign in with ChatGPT\. A Terminal window opens/);
  const code = lines.filter((l) => l.code);
  assert.deepEqual(code.map((l) => [l.text, l.copy]), [['codex login', true]]);
  assert.ok(lines.find((l) => l.small && /did not open/.test(l.text)), 'the fallback line is small');
  ctx.copy(codex);
  assert.deepEqual(copied, ['codex login']);
});

test('ATO-845: Sign in opens the terminal, polls, and moves on once signed in', async () => {
  const out = { installed: true, binPath: null, signedIn: false };
  const inn = { installed: true, binPath: null, signedIn: true };
  const { ctx, events, acts, intervals } = loadLogin([out, out, inn], { ok: true, terminal: 'terminal_app' });
  const codex = ctx.rows[4];
  ctx.WIZ.row = codex;
  ctx.lines(codex); await tick();
  await ctx.login(codex);
  assert.deepEqual(plain(events), [['clicked', 'codex', false], ['terminal', 'codex', true, 'terminal_app']]);
  assert.equal(intervals.length, 1, 'one poll started');
  assert.match(plain(ctx.lines(codex))[1].text, /window opened with the sign-in running/);
  intervals[0](); await tick();
  assert.deepEqual(acts, [], 'still signed out: stays');
  intervals[0](); await tick();
  assert.deepEqual(plain(events.at(-1)), ['succeeded', 'codex', 'number']);
  assert.deepEqual(acts, ['wiz:next'], 'moved on through the router');
});

test('ATO-845: a terminal that did not open says so and still polls', async () => {
  const out = { installed: true, binPath: null, signedIn: false };
  const { ctx, events, intervals } = loadLogin([out], { ok: false, reason: 'no_terminal' });
  const codex = ctx.rows[4];
  ctx.WIZ.row = codex;
  ctx.lines(codex); await tick();
  await ctx.login(codex);
  assert.deepEqual(plain(events.at(-1)), ['terminal', 'codex', false, 'no_terminal']);
  assert.equal(intervals.length, 1);
  const lines = plain(ctx.lines(codex));
  assert.ok(lines.find((l) => l.warn && /Could not open Terminal/.test(l.text)));
});

test('ATO-845: the step draws Sign in for signed out and the old button otherwise, in both places', () => {
  assert.equal((renderer.match(/data-act="wiz:subLogin"/g) || []).length, 2);
  assert.match(renderer, /a === 'wiz:subRecheck' \|\| a === 'wiz:subLogin' \|\| a === 'wiz:subCopy'/);
  assert.match(renderer, /if \(a === 'wiz:subLogin'\) \{ wizSubLogin\(WIZ\.row\); return; \}/);
});
