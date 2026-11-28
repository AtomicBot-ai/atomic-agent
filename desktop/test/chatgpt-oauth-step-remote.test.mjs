// ATO-2512: the provider wizard's "Sign in with ChatGPT" block when the app
// drives an agent on another computer (renderer/chatgpt-oauth-step.js).
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../renderer/chatgpt-oauth-step.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const fresh = (over = {}) => ({supported: true, asking: false, running: false, error: null, startedAt: 0, watch: null, byUser: false, left: false, remote: false, askedAt: 0, ...over});
const flush = () => new Promise((r) => setImmediate(r));

test('on a remote agent the block is the line with the command, and no button', () => {
  const html = S.chatgptOauthBlockHTML(fresh({remote: true}), esc, false);
  assert.match(html, /connected to an agent on another computer/);
  assert.match(html, /<code>atag login chatgpt --device<\/code>/);
  assert.doesNotMatch(html, /data-act="wiz:chatgptOauth"/);
  assert.doesNotMatch(html, /\u2014/);
  assert.equal(S.CHATGPT_OAUTH_REMOTE_COMMAND, 'atag login chatgpt --device');
  // This computer's agent: the button as before.
  assert.match(S.chatgptOauthBlockHTML(fresh(), esc, false), /data-act="wiz:chatgptOauth"/);
});

test('the status answer sets remote; a remote answer is asked again once it is old, a local one is not', async () => {
  let asked = 0;
  let answer = {ok: true, signedIn: false, plan: null, supported: true, remote: true};
  const br = {chatgptOauthStatus: async () => { asked++; return answer; }};
  const st = fresh({supported: null});
  let t = 1000;
  const now = () => t;
  S.chatgptOauthAskSupported(br, () => {}, st, now);
  await flush();
  assert.equal(asked, 1);
  assert.equal(st.remote, true);
  S.chatgptOauthAskSupported(br, () => {}, st, now);   // fresh: not asked again
  await flush();
  assert.equal(asked, 1);
  t += 16000;
  answer = {ok: true, signedIn: false, plan: null, supported: true};   // switched back to this computer
  let redraws = 0;
  S.chatgptOauthAskSupported(br, () => { redraws++; }, st, now);
  assert.equal(st.supported, true, 'the line stays on screen while it asks again');
  await flush();
  assert.equal(asked, 2);
  assert.equal(st.remote, false);
  assert.equal(redraws, 1);
  t += 60000;
  S.chatgptOauthAskSupported(br, () => {}, st, now);   // a local answer is cached for the run, as before
  await flush();
  assert.equal(asked, 2);
});

test('a start main refuses as remote turns the block into the line, with no error and no ended event', async () => {
  const events = [];
  let renders = 0;
  const st = fresh();
  const ctx = {
    br: {chatgptOauthStart: async () => ({ok: false, state: 'failed', reason: 'remote'}), chatgptOauthCancel: async () => ({ok: true})},
    onStep: () => true, inOnboarding: false, render: () => { renders++; }, activate: () => { throw new Error('no'); },
    anx: {subscriptionLoginClicked: () => {}, subscriptionOauthEnded: (o) => events.push(o)},
    setInterval: () => 1,
  };
  await S.chatgptOauthStart(ctx, st);
  assert.equal(st.remote, true);
  assert.equal(st.error, null);
  assert.deepEqual(events, []);
  assert.ok(renders >= 2);
  assert.match(S.chatgptOauthBlockHTML(st, esc, true), /atag login chatgpt --device/);
});

test('"remote" is not an analytics outcome, so it is never sent as one', () => {
  const src = readFileSync(new URL('../main/analytics/catalog.ts', import.meta.url), 'utf8');
  const line = src.slice(src.indexOf('subscription_oauth_login_ended'), src.indexOf('\n', src.indexOf('outcome:', src.indexOf('subscription_oauth_login_ended'))));
  assert.doesNotMatch(line, /"remote"/);
});
