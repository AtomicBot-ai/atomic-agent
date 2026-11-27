// ATO-1747 / ATO-1749: the provider wizard's "Sign in with ChatGPT" through the
// bundled agent (renderer/chatgpt-oauth-step.js), and its analytics events.
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../renderer/chatgpt-oauth-step.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const fresh = () => ({supported: true, asking: false, running: false, error: null, startedAt: 0, watch: null, byUser: false, left: false});
const flush = () => new Promise((r) => setImmediate(r));

/** A bridge whose start the test answers; and a ctx that records what the step did. */
function setup({onStep = () => true} = {}) {
  let answer;
  const calls = {start: 0, cancel: 0};
  const br = {
    chatgptOauthStart: () => { calls.start++; return new Promise((r) => { answer = r; }); },
    chatgptOauthCancel: async () => { calls.cancel++; return {ok: true, state: 'cancelled'}; },
  };
  const events = [];
  const activated = [];
  let watchFn = null;
  let renders = 0;
  const ctx = {
    br, onStep, inOnboarding: true,
    render: () => { renders++; },
    activate: (id) => activated.push(id),
    anx: {
      subscriptionLoginClicked: (cli, ob) => events.push(['clicked', cli, ob]),
      subscriptionLoginSucceeded: (cli, ob) => events.push(['succeeded', cli, ob]),
      subscriptionOauthEnded: (outcome, ob) => events.push(['ended', outcome, ob]),
    },
    setInterval: (fn) => { watchFn = fn; return 1; },
  };
  return {br, ctx, calls, events, activated, answer: (r) => answer(r), watch: () => watchFn && watchFn(), renders: () => renders};
}

test('nothing is drawn until main says the agent supports it', () => {
  assert.equal(S.chatgptOauthBlockHTML({...fresh(), supported: null}, esc, false), '');
  assert.equal(S.chatgptOauthBlockHTML({...fresh(), supported: false}, esc, false), '');
  const html = S.chatgptOauthBlockHTML(fresh(), esc, false);
  assert.match(html, /data-act="wiz:chatgptOauth">Sign in with ChatGPT</);
  assert.match(html, />Experimental</);
});

test('while signing in: the browser line and Cancel, no Sign in button', () => {
  const html = S.chatgptOauthBlockHTML({...fresh(), running: true}, esc, true);
  assert.match(html, /Finish signing in in your browser/);
  assert.match(html, /data-act="wiz:chatgptOauthCancel"/);
  assert.doesNotMatch(html, /data-act="wiz:chatgptOauth"/);
  assert.match(html, /btn btn-s xs/);
});

test('supported is asked once and redraws when it is yes', async () => {
  const st = {...fresh(), supported: null};
  let asked = 0, redraws = 0;
  const br = {chatgptOauthStatus: async () => { asked++; return {ok: true, signedIn: false, plan: null, supported: true}; }};
  S.chatgptOauthAskSupported(br, () => redraws++, st);
  S.chatgptOauthAskSupported(br, () => redraws++, st);
  await flush();
  assert.equal(st.supported, true);
  assert.equal(asked, 1);
  assert.equal(redraws, 1);
  S.chatgptOauthAskSupported(br, () => redraws++, st);
  assert.equal(asked, 1);
  const old = {...fresh(), supported: null};
  S.chatgptOauthAskSupported({chatgptOauthStatus: async () => ({ok: true, supported: false})}, () => {}, old);
  await flush();
  assert.equal(old.supported, false);
  const none = {...fresh(), supported: null};
  S.chatgptOauthAskSupported({}, () => {}, none);
  assert.equal(none.supported, false);
});

test('signed in: the entry the agent wrote is activated, nothing else is written', async () => {
  const st = fresh();
  const h = setup();
  const done = S.chatgptOauthStart(h.ctx, st);
  assert.equal(st.running, true);
  // A second click while it runs starts nothing.
  await S.chatgptOauthStart(h.ctx, st);
  assert.equal(h.calls.start, 1);
  h.answer({ok: true, state: 'signed_in', providerId: 'chatgpt-sub'});
  await done;
  assert.equal(st.running, false);
  assert.deepEqual(h.activated, ['chatgpt-sub']);
  assert.deepEqual(h.events.map((e) => e.slice(0, 2)), [['clicked', 'chatgpt-oauth'], ['succeeded', 'chatgpt-oauth']]);
  assert.equal(st.error, null);
});

test('each failure reason shows its fixed sentence and sends the ended event', async () => {
  for (const reason of ['timeout', 'no_account', 'failed']) {
    const st = fresh();
    const h = setup();
    const done = S.chatgptOauthStart(h.ctx, st);
    h.answer({ok: false, state: 'failed', reason});
    await done;
    assert.equal(st.error, S.CHATGPT_OAUTH_ERRORS[reason]);
    assert.deepEqual(h.events.at(-1), ['ended', reason, true]);
    assert.deepEqual(h.activated, []);
  }
  // A reason off the list reads as failed.
  assert.equal(S.chatgptOauthReason({reason: '<script>'}), 'failed');
  assert.equal(S.chatgptOauthReason(null), 'failed');
});

test('Cancel stops the sign-in in main and leaves no error line', async () => {
  const st = fresh();
  const h = setup();
  const done = S.chatgptOauthStart(h.ctx, st);
  assert.equal(S.chatgptOauthCancel(h.br, true, st), true);
  await flush();
  assert.equal(h.calls.cancel, 1);
  h.answer({ok: false, state: 'failed', reason: 'cancelled'});
  await done;
  assert.equal(st.error, null);
  assert.deepEqual(h.events.at(-1), ['ended', 'cancelled', true]);
  assert.equal(S.chatgptOauthCancel(h.br, true, st), false);
});

test('leaving the step (Back, Esc, closing the wizard) cancels the sign-in and draws nothing after', async () => {
  const st = fresh();
  let onStep = true;
  const h = setup({onStep: () => onStep});
  const done = S.chatgptOauthStart(h.ctx, st);
  h.watch();
  assert.equal(h.calls.cancel, 0);
  onStep = false;
  h.watch();
  await flush();
  assert.equal(h.calls.cancel, 1);
  const before = h.renders();
  h.answer({ok: false, state: 'failed', reason: 'cancelled'});
  await done;
  assert.equal(h.renders(), before, 'no redraw for a wizard that is gone');
  assert.deepEqual(h.activated, []);
  assert.deepEqual(h.events.at(-1), ['ended', 'cancelled', true]);
});

test('signed in after the wizard closed: nothing is activated', async () => {
  const st = fresh();
  let onStep = true;
  const h = setup({onStep: () => onStep});
  const done = S.chatgptOauthStart(h.ctx, st);
  onStep = false;
  h.answer({ok: true, state: 'signed_in', providerId: 'chatgpt-sub'});
  await done;
  assert.deepEqual(h.activated, []);
});

test('a bridge that throws ends as failed, never as a crash', async () => {
  const st = fresh();
  const h = setup();
  h.br.chatgptOauthStart = async () => { throw new Error('ipc gone'); };
  await S.chatgptOauthStart(h.ctx, st);
  assert.equal(st.running, false);
  assert.equal(st.error, S.CHATGPT_OAUTH_ERRORS.failed);
  // No bridge at all: the click does nothing.
  await S.chatgptOauthStart({...h.ctx, br: {}}, fresh());
});

test('renderer.js wires the two verbs, also inside first run, and both wizard screens draw the block', () => {
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(src, /a === 'wiz:chatgptOauth'\) \{ wizChatgptOauthStart\(WIZ\.row\)/);
  assert.match(src, /a === 'wiz:chatgptOauthCancel'\) \{ chatgptOauthCancel\(BR, true\)/);
  assert.match(src, /a === 'wiz:subCopy' \|\| a === 'wiz:chatgptOauth' \|\| a === 'wiz:chatgptOauthCancel'\)\) \{/);
  assert.equal((src.match(/\+ wizChatgptOauthHTML\(k, (?:true|false)\)/g) || []).length, 2);
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('chatgpt-oauth-step.js') > 0 && html.indexOf('chatgpt-oauth-step.js') < html.indexOf('renderer.js'));
});

/* ------------------------------------------------------------ ATO-1749 */

test('the catalogue takes cli chatgpt-oauth and the ended event; an unknown value is dropped', () => {
  const V = require('../out/main/analytics/validate.js');
  assert.deepEqual(V.validateEvent('subscription_login_clicked', {cli: 'chatgpt-oauth', step: 'settings'}, 'ui').props,
    {cli: 'chatgpt-oauth', step: 'settings'});
  assert.equal(V.validateEvent('subscription_login_succeeded', {cli: 'chatgpt-oauth', step: 'onboarding', seconds_to_sign_in: 30}, 'ui').props.cli, 'chatgpt-oauth');
  assert.deepEqual(V.validateEvent('subscription_oauth_login_ended', {outcome: 'no_account', step: 'onboarding'}, 'ui').props,
    {outcome: 'no_account', step: 'onboarding'});
  const odd = V.validateEvent('subscription_oauth_login_ended', {outcome: 'signed_in', step: 'settings', email: 'a@b.c', plan: 'plus'}, 'ui').props;
  assert.deepEqual(odd, {step: 'settings'});
});
