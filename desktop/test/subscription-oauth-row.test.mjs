// ATO-2511: the ChatGPT sign-in provider (`subscription-oauth`, added by
// `atag login chatgpt`) in Settings › Models and wherever a provider is named
// (renderer/subscription-oauth-row.js), and the hooks in renderer.js.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
const require = createRequire(import.meta.url);
const R = require('../renderer/subscription-oauth-row.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const fresh = (over = {}) => ({status: null, at: 0, asking: false, busy: null, error: null, detail: null, showDetail: false, note: null, ...over});
const flush = () => new Promise((r) => setImmediate(r));
const CHATGPT = {id: 'chatgpt-sub', kind: 'subscription-oauth', subscriptionOauth: {service: 'chatgpt'}, defaultChatModel: 'gpt-6.2-sol'};
const COPILOT = {id: 'copilot-sub', kind: 'subscription-oauth', subscriptionOauth: {service: 'copilot'}};
const SIGNED_IN = {ok: true, signedIn: true, plan: 'plus', supported: true};
const SIGNED_OUT = {ok: true, signedIn: false, plan: null, supported: true};

function ctxFor(over = {}) {
  return {
    open: '<button class="tuirow" data-act="llm:row:3">', radio: '<span class="tk-radio"></span>', mark: '<span class="logo"></span>',
    name: 'ChatGPT (subscription)', index: 3, effect: '<span class="llm-effect"></span>',
    rowAct: (a, l) => '<span role="button" class="llm-rowact" data-act="' + esc(a) + '">' + esc(l) + '</span>',
    chip: (tone, html) => '<span class="tk-chip tk-chip--' + tone + '">' + html + '</span>',
    esc, br: null, repaint: () => {}, ...over,
  };
}

test('a sign-in entry is named and marked by its service; any other provider is not', () => {
  assert.equal(R.subOauthService(CHATGPT), 'chatgpt');
  assert.equal(R.subOauthService({id: 'x', kind: 'subscription-oauth'}), 'chatgpt', 'no service is a ChatGPT entry (login-command.ts)');
  assert.equal(R.subOauthService(COPILOT), 'copilot');
  assert.equal(R.subOauthService({id: 'codex-cli', kind: 'subscription-cli'}), '');
  assert.equal(R.subOauthWord('chatgpt-sub', [CHATGPT]), 'ChatGPT (subscription)');
  assert.equal(R.subOauthWord('copilot-sub', [COPILOT]), 'GitHub Copilot (subscription)');
  assert.equal(R.subOauthLogoKey('chatgpt-sub', [CHATGPT]), 'openai');
  assert.equal(R.subOauthLogoKey('copilot-sub', [COPILOT]), 'github');
  // Before the config is read, the agent's own ids still name it; a second sign-in entry too.
  assert.equal(R.subOauthWord('chatgpt-sub-2', []), 'ChatGPT (subscription)');
  // An entry that happens to have that id but another kind keeps its own name.
  assert.equal(R.subOauthWord('chatgpt-sub', [{id: 'chatgpt-sub', kind: 'openai-compatible'}]), '');
  assert.equal(R.subOauthWord('openrouter', []), '');
  assert.equal(R.subOauthLogoKey('my-server', []), '');
});

test('the row asks main once for the sign-in state and redraws on the answer', async () => {
  let asked = 0, redraws = 0;
  const br = {chatgptOauthStatus: async () => { asked++; return SIGNED_IN; }};
  const st = fresh();
  const html = R.subOauthRowHTML(CHATGPT, ctxFor({br, repaint: () => { redraws++; }}), st);
  assert.match(html, /Checking sign-in/);
  R.subOauthRowHTML(CHATGPT, ctxFor({br}), st);   // a second paint while asking asks nothing
  await flush();
  assert.equal(asked, 1);
  assert.equal(redraws, 1);
  R.subOauthRowHTML(CHATGPT, ctxFor({br}), st);   // fresh: not asked again
  await flush();
  assert.equal(asked, 1);
});

test('signed in: the name, the id, a green chip with the plan, Sign out and Remove; no Edit, no "No key"', () => {
  const html = R.subOauthRowHTML(CHATGPT, ctxFor(), fresh({status: SIGNED_IN, at: Date.now()}));
  assert.match(html, /<span class="llm-name">ChatGPT \(subscription\)<\/span>/);
  assert.match(html, /llm-id mono">chatgpt-sub</);
  assert.match(html, /tk-chip--green">Signed in · Plus</);
  assert.match(html, /data-act="llm:subOauth:signOut">Sign out</);
  assert.match(html, /data-act="llm:removeAt:3">Remove</);
  assert.doesNotMatch(html, /llm:edit:|No key|Key saved/);
  assert.ok(html.endsWith('</button>'));
});

test('signed out: an amber chip, one line why, and Sign in', () => {
  const html = R.subOauthRowHTML(CHATGPT, ctxFor(), fresh({status: SIGNED_OUT, at: Date.now()}));
  assert.match(html, /tk-chip--amber">Signed out</);
  assert.match(html, /Sign in again to use your ChatGPT plan here\./);
  assert.match(html, /data-act="llm:subOauth:signIn">Sign in</);
  assert.doesNotMatch(html, /llm:subOauth:signOut/);
});

test('an agent that cannot do it shows the plan line and no sign buttons; a failed check offers Check again', () => {
  const unsupported = R.subOauthRowHTML(CHATGPT, ctxFor(), fresh({status: {ok: true, signedIn: false, plan: null, supported: false}, at: Date.now()}));
  assert.match(unsupported, /Uses your ChatGPT plan/);
  assert.doesNotMatch(unsupported, /llm:subOauth:sign/);
  const unknown = R.subOauthRowHTML(CHATGPT, ctxFor(), fresh({status: {ok: false}, at: Date.now()}));
  assert.match(unknown, /Sign-in unknown/);
  assert.match(unknown, /data-act="llm:subOauth:check">Check again</);
});

test('Copilot gets its name and mark, no ChatGPT sign-in state and no Sign out', () => {
  let asked = 0;
  const html = R.subOauthRowHTML(COPILOT, ctxFor({name: 'GitHub Copilot (subscription)', br: {chatgptOauthStatus: async () => { asked++; return SIGNED_IN; }}}), fresh());
  assert.equal(asked, 0);
  assert.match(html, /Uses your Copilot plan/);
  assert.doesNotMatch(html, /llm:subOauth:/);
});

test('Sign out: busy line in place, then signed out with a done line; the agent words never show', async () => {
  let answer;
  let signOuts = 0, repaints = 0;
  const br = {chatgptOauthSignOut: () => { signOuts++; return new Promise((r) => { answer = r; }); }};
  const st = fresh({status: SIGNED_IN, at: Date.now()});
  const done = R.subOauthAct('signOut', {br, repaint: () => { repaints++; }}, st);
  assert.equal(st.busy, 'signOut');
  let html = R.subOauthRowHTML(CHATGPT, ctxFor(), st);
  assert.match(html, /tk-spin"><\/span>Signing out/);
  assert.doesNotMatch(html, /llm:subOauth:signOut/, 'no second click while it runs');
  await R.subOauthAct('signOut', {br}, st);   // ignored while busy
  assert.equal(signOuts, 1);
  answer({ok: true, state: 'signed_out', hadSignIn: true});
  await done;
  assert.equal(st.busy, null);
  assert.equal(st.status.signedIn, false);
  html = R.subOauthRowHTML(CHATGPT, ctxFor(), st);
  assert.match(html, /tk-chip--amber">Signed out</);
  assert.match(html, /Signed out\. Chats that use ChatGPT will ask you to sign in again\./);
  assert.match(html, /llm:subOauth:signIn/);
  assert.ok(repaints >= 2);
});

test('a failed sign-out is one fixed sentence; the agent output sits behind Details', async () => {
  const br = {chatgptOauthSignOut: async () => ({ok: false, state: 'failed', reason: 'failed', detail: 'Could not delete /Users/me/.atomic-agent/auth/chatgpt.json.'})};
  const st = fresh({status: SIGNED_IN, at: Date.now()});
  await R.subOauthAct('signOut', {br}, st);
  let html = R.subOauthRowHTML(CHATGPT, ctxFor(), st);
  assert.match(html, /llm-sub is-err" role="status">Could not sign out of ChatGPT\. Try again\.</);
  assert.doesNotMatch(html, /\/Users\/me/, 'the path is not on screen until Details');
  assert.match(html, /data-act="llm:subOauth:details">Details</);
  assert.match(html, /llm:subOauth:signOut/, 'Try again is the same button');
  await R.subOauthAct('details', {br}, st);
  html = R.subOauthRowHTML(CHATGPT, ctxFor(), st);
  assert.match(html, /llm-sub mono">Could not delete \/Users\/me/);
  assert.match(html, /Hide details/);
  // An old agent without `logout`: say to update.
  await R.subOauthAct('signOut', {br: {chatgptOauthSignOut: async () => ({ok: false, reason: 'unsupported'})}}, st);
  assert.equal(st.error, R.SUB_OAUTH_ERRORS.unsupported);
  // A bridge that throws is the same failure, never a throw.
  await R.subOauthAct('signOut', {br: {chatgptOauthSignOut: async () => { throw new Error('ipc gone'); }}}, st);
  assert.equal(st.error, R.SUB_OAUTH_ERRORS.signOut);
});

test('Sign in from the row: the browser line with Cancel; success asks the state again', async () => {
  let answer, cancels = 0;
  const br = {
    chatgptOauthStart: () => new Promise((r) => { answer = r; }),
    chatgptOauthCancel: async () => { cancels++; return {ok: true, state: 'cancelled'}; },
  };
  const st = fresh({status: SIGNED_OUT, at: Date.now()});
  const done = R.subOauthAct('signIn', {br}, st);
  const html = R.subOauthRowHTML(CHATGPT, ctxFor(), st);
  assert.match(html, /Finish signing in in your browser\./);
  assert.match(html, /data-act="llm:subOauth:cancel">Cancel</);
  answer({ok: true, state: 'signed_in', providerId: 'chatgpt-sub'});
  await done;
  assert.equal(st.status, null, 'asked again on the next paint');
  assert.equal(st.note, 'Signed in.');
  // Cancelled by the person: no error line.
  const st2 = fresh({status: SIGNED_OUT, at: Date.now()});
  const d2 = R.subOauthAct('signIn', {br}, st2);
  await R.subOauthAct('cancel', {br}, st2);
  await flush();
  assert.equal(cancels, 1);
  answer({ok: false, state: 'failed', reason: 'cancelled'});
  await d2;
  assert.equal(st2.error, null);
  // A timeout: its fixed sentence; an unknown reason: the generic one.
  const st3 = fresh({status: SIGNED_OUT, at: Date.now()});
  const d3 = R.subOauthAct('signIn', {br}, st3);
  answer({ok: false, state: 'failed', reason: 'timeout'});
  await d3;
  assert.equal(st3.error, R.SUB_OAUTH_ERRORS.timeout);
  R.subOauthTakeSignIn({ok: false, reason: 'weird <b>'}, st3);
  assert.equal(st3.error, R.SUB_OAUTH_ERRORS.failed);
});

test('no line on screen carries a long dash', () => {
  for (const s of Object.values(R.SUB_OAUTH_ERRORS)) assert.doesNotMatch(s, /\u2014/);
  const src = readFileSync(new URL('../renderer/subscription-oauth-row.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\u2014/);
});

test('renderer.js names, marks and draws the entry through this file, and the script loads before it', () => {
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  const body = (name) => src.slice(src.indexOf('function ' + name + '('), src.indexOf('\n}\n', src.indexOf('function ' + name + '(')));
  assert.match(body('providerWord'), /subOauthWord\(s, /);
  assert.match(body('providerLogoKey'), /subOauthLogoKey\(s, /);
  assert.match(body('llmHasRealKey'), /p\.kind === 'subscription-oauth'\) return true/);
  const row = body('llmRowHTML');
  assert.ok(row.indexOf('if (subOauthService(p)) return subOauthRowHTML(') > row.indexOf("row.kind === 'cloudProvider'"));
  assert.match(body('llmAct'), /verb === 'subOauth'\) \{ subOauthAct\(arg, \{br: BR, repaint: llmRepaint\}\)/);
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = html.indexOf('<script src="subscription-oauth-row.js">');
  assert.ok(at > 0 && at < html.indexOf('<script src="renderer.js">'));
});

test('providerLogoKey: the sign-in entry wears the OpenAI mark; it still works where this file is not loaded', () => {
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  const fn = (name) => src.slice(src.indexOf('function ' + name + '('), src.indexOf('\n}\n', src.indexOf('function ' + name + '(')) + 3);
  const keys = src.slice(src.indexOf('const PROVIDER_LOGO_KEYS = {'), src.indexOf('};', src.indexOf('const PROVIDER_LOGO_KEYS = {')) + 2);
  const bare = createContext({});
  runInContext(keys + fn('providerLogoKey'), bare);
  assert.equal(bare.providerLogoKey('my-server'), '', 'no ReferenceError without subscription-oauth-row.js');
  const withRow = createContext({LIVE_CONFIG: {llm: {providers: [CHATGPT]}}, llmProviders: () => [CHATGPT], subOauthLogoKey: R.subOauthLogoKey});
  runInContext(keys + fn('providerLogoKey'), withRow);
  assert.equal(withRow.providerLogoKey('chatgpt-sub'), 'openai');
  assert.equal(withRow.providerLogoKey('openrouter'), 'openrouter');
});
