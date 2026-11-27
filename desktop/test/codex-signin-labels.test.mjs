// ATO-2739: the Codex row of the Add provider wizard drew two buttons both
// called "Sign in with ChatGPT" (the terminal's `codex login` and the bundled
// agent's browser sign-in), and "No Codex CLI?" beside a Codex CLI that was
// installed. Now the two read differently, one leads, and the hint matches
// the CLI. Also the Settings model list error banner (llm-model-list.js).
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
const require = createRequire(import.meta.url);
const S = require('../renderer/chatgpt-oauth-step.js');
const L = require('../renderer/llm-model-list.js');

const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
function slice(start, end) {
  const i = renderer.indexOf(start);
  assert.ok(i >= 0, start);
  const j = renderer.indexOf(end, i);
  assert.ok(j > i, end);
  return renderer.slice(i, j);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const fresh = () => ({supported: true, asking: false, running: false, error: null, startedAt: 0, watch: null, byUser: false, left: false, restarting: false});
const MISSING = {installed: false, signedIn: null};
const SIGNED_OUT = {installed: true, signedIn: false};
const SIGNED_IN = {installed: true, signedIn: true};

/** renderer.js wizSubLoginButton / wizSubLoginCls with a status and a platform the test picks. */
function loadButtons(status, platform, oauth) {
  const ctx = createContext({
    navigator: {platform},
    wizService: (k) => k.word,
    wizSubStatus: () => status,
    CHATGPT_OAUTH: oauth,
    chatgptOauthIsPrimary: S.chatgptOauthIsPrimary,
  });
  runInContext(slice('function wizSubLoginButton(k)', '/** Signed out, as far as the login file says')
    + ';this.label = wizSubLoginButton; this.cls = wizSubLoginCls;', ctx);
  return ctx;
}
const codex = {subscriptionCli: 'codex', word: 'Codex', plan: 'ChatGPT'};
const claude = {subscriptionCli: 'claude', word: 'Claude Code', plan: 'Claude'};

test('the terminal sign-in and the browser sign-in have different labels, on every platform', () => {
  const mac = loadButtons(SIGNED_OUT, 'MacIntel', fresh());
  const win = loadButtons(SIGNED_OUT, 'Win32', fresh());
  assert.equal(mac.label(codex), 'Sign in with Codex in Terminal');
  assert.equal(win.label(codex), 'Sign in with Codex in PowerShell');
  for (const label of [mac.label(codex), win.label(codex)]) assert.notEqual(label, S.CHATGPT_OAUTH_BUTTON);
  assert.equal(S.CHATGPT_OAUTH_BUTTON, 'Sign in with ChatGPT in the browser');
  const block = S.chatgptOauthBlockHTML(fresh(), esc, false, SIGNED_OUT);
  assert.doesNotMatch(block, />Sign in with Codex/);
  // The Claude row is unchanged.
  assert.equal(mac.label(claude), 'Sign in with Claude');
});

test('one primary: the browser sign-in leads when the agent can do it and the CLI is signed out or missing', () => {
  // Signed out, agent can do it: the browser button is btn-p, the terminal one steps back.
  const out = S.chatgptOauthBlockHTML(fresh(), esc, false, SIGNED_OUT);
  assert.match(out, /class="btn btn-p" data-act="wiz:chatgptOauth"/);
  assert.equal(loadButtons(SIGNED_OUT, 'MacIntel', fresh()).cls(codex), 'btn-s');
  // The composer popover keeps its small size.
  assert.match(S.chatgptOauthBlockHTML(fresh(), esc, true, SIGNED_OUT), /class="btn btn-p xs" data-act="wiz:chatgptOauth"/);
  // The agent cannot do it: the terminal button is the only way and stays primary.
  assert.equal(loadButtons(SIGNED_OUT, 'MacIntel', {...fresh(), supported: false}).cls(codex), 'btn-p');
  assert.equal(loadButtons(SIGNED_OUT, 'MacIntel', {...fresh(), supported: null}).cls(codex), 'btn-p');
  // Signed in or not known yet: the browser button is the quiet alternative.
  assert.match(S.chatgptOauthBlockHTML(fresh(), esc, false, SIGNED_IN), /class="btn btn-s" data-act="wiz:chatgptOauth"/);
  assert.match(S.chatgptOauthBlockHTML(fresh(), esc, false, null), /class="btn btn-s" data-act="wiz:chatgptOauth"/);
  // Claude never steps back.
  assert.equal(loadButtons(SIGNED_OUT, 'MacIntel', fresh()).cls(claude), 'btn-p');
});

test('"No Codex CLI?" only when the CLI is not installed', () => {
  assert.match(S.chatgptOauthBlockHTML(fresh(), esc, false, MISSING), /No Codex CLI\?/);
  for (const cli of [SIGNED_OUT, SIGNED_IN, null, {installed: null, signedIn: null}]) {
    const html = S.chatgptOauthBlockHTML(fresh(), esc, false, cli);
    assert.doesNotMatch(html, /No Codex CLI/, JSON.stringify(cli));
    assert.match(html, /Or sign in with your ChatGPT account in the browser/);
  }
  assert.equal(S.chatgptOauthCliState(MISSING), 'missing');
  assert.equal(S.chatgptOauthCliState(SIGNED_OUT), 'signed_out');
  assert.equal(S.chatgptOauthCliState(SIGNED_IN), 'ready');
});

test('renderer.js hands the CLI status to the block and picks the footer class in both wizard screens', () => {
  assert.match(renderer, /chatgptOauthBlockHTML\(CHATGPT_OAUTH, esc, compact, wizSubStatus\(k\)\)/);
  assert.equal((renderer.match(/'<button class="btn ' \+ wizSubLoginCls\(k\) \+ '(?: xs)?" data-act="wiz:subLogin"/g) || []).length, 2);
  assert.match(renderer, /if \(a === 'wiz:chatgptOauthReopen'\) \{ chatgptOauthRestart\(BR, render\); return; \}/);
});

/* ------------------------------------------- Open the sign-in page again */

function setup({onStep = () => true} = {}) {
  const answers = [];
  const calls = {start: 0, cancel: 0};
  const br = {
    chatgptOauthStart: () => { calls.start++; return new Promise((r) => { answers.push(r); }); },
    chatgptOauthCancel: async () => { calls.cancel++; return {ok: true, state: 'cancelled'}; },
  };
  const events = [];
  const activated = [];
  const ctx = {
    br, onStep, inOnboarding: false, render: () => {}, activate: (id) => activated.push(id),
    anx: {
      subscriptionLoginClicked: (cli) => events.push(['clicked', cli]),
      subscriptionLoginSucceeded: (cli) => events.push(['succeeded', cli]),
      subscriptionOauthEnded: (outcome) => events.push(['ended', outcome]),
    },
    setInterval: () => 1,
  };
  return {br, ctx, calls, events, activated, answer: (i, r) => answers[i](r)};
}
const flush = () => new Promise((r) => setImmediate(r));

test('Open the sign-in page again cancels the running sign-in, then starts a new one that opens a fresh page', async () => {
  const st = fresh();
  const h = setup();
  const done = S.chatgptOauthStart(h.ctx, st);
  assert.equal(S.chatgptOauthRestart(h.br, () => {}, st), true);
  assert.equal(st.restarting, true);
  // A second click while it restarts does nothing; the button is drawn disabled.
  assert.equal(S.chatgptOauthRestart(h.br, () => {}, st), false);
  assert.match(S.chatgptOauthBlockHTML(st, esc, false, SIGNED_OUT), /data-act="wiz:chatgptOauthReopen" disabled>/);
  await flush();
  assert.equal(h.calls.cancel, 1);
  h.answer(0, {ok: false, state: 'failed', reason: 'cancelled'});
  await flush();
  assert.equal(h.calls.start, 2, 'a new sign-in was started');
  assert.equal(st.running, true);
  assert.equal(st.error, null);
  h.answer(1, {ok: true, state: 'signed_in', providerId: 'chatgpt-sub'});
  await done;
  assert.deepEqual(h.activated, ['chatgpt-sub']);
  // One click, one success: the restart sends no clicked or ended of its own.
  assert.deepEqual(h.events, [['clicked', 'chatgpt-oauth'], ['succeeded', 'chatgpt-oauth']]);
});

test('a restart after the step was left starts nothing new', async () => {
  const st = fresh();
  let here = true;
  const h = setup({onStep: () => here});
  const done = S.chatgptOauthStart(h.ctx, st);
  S.chatgptOauthRestart(h.br, () => {}, st);
  here = false;
  h.answer(0, {ok: false, state: 'failed', reason: 'cancelled'});
  await done;
  assert.equal(h.calls.start, 1);
  assert.equal(st.restarting, false);
  assert.deepEqual(h.events.at(-1), ['ended', 'cancelled']);
});

test('Cancel pressed while the restart waits wins: no new sign-in starts', async () => {
  const st = fresh();
  const h = setup();
  const done = S.chatgptOauthStart(h.ctx, st);
  S.chatgptOauthRestart(h.br, () => {}, st);
  S.chatgptOauthCancel(h.br, true, st);
  assert.equal(st.restarting, false);
  h.answer(0, {ok: false, state: 'failed', reason: 'cancelled'});
  await done;
  assert.equal(h.calls.start, 1);
  assert.equal(st.error, null);
  assert.deepEqual(h.events.at(-1), ['ended', 'cancelled']);
});

test('a sign-in that finished just as the restart was clicked is kept, not restarted', async () => {
  const st = fresh();
  const h = setup();
  const done = S.chatgptOauthStart(h.ctx, st);
  S.chatgptOauthRestart(h.br, () => {}, st);
  h.answer(0, {ok: true, state: 'signed_in', providerId: 'chatgpt-sub'});
  await done;
  assert.equal(h.calls.start, 1);
  assert.deepEqual(h.activated, ['chatgpt-sub']);
  assert.equal(S.chatgptOauthRestart(h.br, () => {}, st), false, 'nothing runs');
});

/* ------------------------------------------- Settings model list error */

test('the model list error has no nested parentheses and no status code in its words', () => {
  const b = L.llmListErrorBanner('OpenRouter did not accept the saved key (401).');
  assert.equal(b.text, 'Couldn’t fetch the model list: OpenRouter did not accept the saved key. Showing the current model only.');
  assert.equal(b.detail, 'HTTP 401');
  const five = L.llmListErrorBanner('OpenRouter had a problem answering (HTTP 502). Try again in a moment.');
  assert.equal(five.text, 'Couldn’t fetch the model list: OpenRouter had a problem answering. Try again in a moment. Showing the current model only.');
  assert.equal(five.detail, 'HTTP 502');
  const cert = L.llmListErrorBanner('OpenRouter answered with a certificate this app does not trust (SELF_SIGNED_CERT_IN_CHAIN).');
  assert.doesNotMatch(cert.text, /SELF_SIGNED/);
  assert.equal(cert.detail, 'SELF_SIGNED_CERT_IN_CHAIN');
  const late = L.llmListErrorBanner(L.llmListDeadlineLine('OpenRouter'));
  assert.equal(late.text, 'Couldn’t fetch the model list: no answer from OpenRouter within 30 s. Showing the current model only.');
  assert.equal(late.detail, '');
  for (const t of [b.text, five.text, cert.text, late.text, L.llmListErrorBanner('').text]) {
    assert.doesNotMatch(t, /\(/);
    assert.doesNotMatch(t, /\.\./);
  }
  const span = L.llmListErrorSpanHTML('OpenRouter did not accept the saved key (401).', esc);
  assert.equal(span, '<span class="grow" title="HTTP 401">Couldn’t fetch the model list: OpenRouter did not accept the saved key. Showing the current model only.</span>');
  const list = renderer.slice(renderer.indexOf('function llmCloudModelListHTML('));
  assert.match(list.slice(0, 4000), /ic\('alert'\) \+ llmListErrorSpanHTML\(section\.error, esc\)/);
  assert.doesNotMatch(renderer, /Couldn’t fetch the model list \(/);
});

test('"within 90 s" in the wizard and the model picker is main\'s own deadline on the list', () => {
  // Those lines read main's `timedOut`, set when providerModels' `cli(args, 90_000)` runs out
  // (agent-cli.ts); Settings has its own 30 s deadline first and says so (llmListDeadlineLine).
  const cli = readFileSync(new URL('../main/agent-cli.ts', import.meta.url), 'utf8');
  const fn = cli.slice(cli.indexOf('export async function providerModels('), cli.indexOf('export function answeredBeforeCrash('));
  const ms = /cli\(args, (\d+)_000\)/.exec(fn);
  assert.ok(ms, 'providerModels has its deadline');
  const said = renderer.match(/did not come back within (\d+) s/g) || [];
  assert.ok(said.length >= 2);
  for (const line of said) assert.equal(line, 'did not come back within ' + ms[1] + ' s');
  assert.equal(L.LLM_LIST_DEADLINE_MS, 30000);
});
