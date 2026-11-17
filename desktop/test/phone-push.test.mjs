// Settings › Connections › Phone push (ATO-1129): the pane markup and its
// switch (renderer/phone-push.js), where it sits in Settings, and the pure
// half of main (main/push-cli.ts, from the built output: npm run build first).
// No request leaves the process: the bridge is a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ic = (n) => '<i:' + n + '>';
const h = {esc, ic};
const ON = {enabled:true, server:'https://ntfy.sh', topic:'atag-abc', tokenEnv:'NTFY_TOKEN', subscribeUrl:'https://ntfy.sh/atag-abc'};
const OFF = Object.assign({}, ON, {enabled:false});

/* A fresh copy of the module with a stub bridge, so each test owns PUSH. */
function load(bridge) {
  const ctx = vm.createContext({BR: bridge, render: () => {}, esc, ic, module: {exports: {}}, URL});
  vm.runInContext(readFileSync(new URL('../renderer/phone-push.js', import.meta.url), 'utf8'), ctx);
  return ctx.module.exports;
}

test('Phone push sits next to Telegram in Connections, in the tab list and the palette', () => {
  // Discord (ATO-516) sits between Telegram and Phone push.
  assert.match(source, /\['connections','Connections','plug',\['mcp','telegram','discord','push','composio'\]\]/);
  assert.match(source, /\['telegram','Telegram'\],\['discord','Discord'\],\['push','Phone push'\],\['composio','Composio'\]/);
  assert.match(source, /\['bell','Phone push','Settings · Connections','','settings:push'\]/);
  for (const hook of ["pane === 'push') phonePushTabEntered()", "p === 'push') return pushTab()",
    "k === 'push') { close(); phonePushAct(a.slice(5))"]) {
    assert.ok(source.includes(hook), hook);
  }
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const helper = index.indexOf('<script src="phone-push.js">');
  assert.ok(helper > 0 && helper < index.indexOf('<script src="renderer.js">'));
});

test('off: one sentence and Set up, nothing else; set up: three steps, the switch, privacy and New address', () => {
  const P = load(null);
  const off = P.phonePushPaneHTML({state: OFF, busy: null}, h);
  assert.match(off, /Get a notification on your phone when a long task finishes or the agent needs you\./);
  assert.match(off, /data-act="push:setup"[^>]*>Set up</);
  assert.equal((off.match(/data-act=/g) || []).length, 1, 'Set up is the only control while off');
  for (const gone of [/atag-abc/, /push:test/, /push:enable/, /push:newTopic/, /tk-switch/, /ntfy app/]) assert.doesNotMatch(off, gone);
  // A fresh install: off, no topic yet.
  const fresh = P.phonePushPaneHTML({state: Object.assign({}, OFF, {topic: null, subscribeUrl: null}), busy: null}, h);
  assert.match(fresh, /push:setup/);
  assert.doesNotMatch(fresh, /tk-switch/);
  const on = P.phonePushPaneHTML({state: ON, busy: null}, h);
  assert.match(on, /1\. Install the free ntfy app/);
  assert.ok(on.includes('data-url="' + P.PUSH_APP_IOS + '"') && P.PUSH_APP_IOS === 'https://apps.apple.com/app/ntfy/id1625396347');
  assert.ok(on.includes('data-url="' + P.PUSH_APP_ANDROID + '"') && P.PUSH_APP_ANDROID === 'https://play.google.com/store/apps/details?id=io.heckel.ntfy');
  assert.match(on, /2\. Subscribe to this topic in the app/);
  assert.match(on, /data-push-url>atag-abc</);
  assert.match(on, /paste this topic name and tap Subscribe\. Leave Use another server off\./);
  const own = P.phonePushPaneHTML({state: Object.assign({}, ON, {server:'https://ntfy.example.com', subscribeUrl:'https://ntfy.example.com/atag-abc'}), busy: null}, h);
  assert.match(own, /Turn on Use another server and enter <b class="sd-mono">https:\/\/ntfy\.example\.com<\/b>\./);
  assert.match(on, /data-act="push:copy"/);
  assert.match(on, /3\. Send a test notification/);
  assert.match(on, /data-act="push:test"/);
  assert.match(on, /role="switch" aria-checked="true"[^>]*data-act="push:enable"/);
  assert.match(on, /Anyone who knows this address can read your notifications, so keep it private\. Notifications show a short title and the start of the answer, never tool output\./);
  assert.match(on, /data-act="push:newTopic"[^>]*>New address</);
  assert.doesNotMatch(on, /New topic|sd-pushcard|sd-tgcard/, 'no centred status card over the rows');
  assert.match(P.phonePushPaneHTML({state: Object.assign({}, ON, {server:'https://ntfy.example.com', subscribeUrl:'https://ntfy.example.com/atag-abc'}), busy: null}, h), /Notifications go to ntfy\.example\.com\./);
  // The test's answer asks; it never says the phone got it.
  const sent = P.phonePushPaneHTML({state: ON, busy: null, msg: P.PUSH_TEST_SENT}, h);
  assert.match(sent, /Sent\. Did it arrive on your phone\?/);
  assert.doesNotMatch(sent, /Check your phone|arrived\./);
  assert.match(P.phonePushPaneHTML({state: null, unsupported: true, err: 'update'}, h), /needs a newer agent/);
  assert.doesNotMatch(on + off + sent, /—/);
});

test('opening the tab only reads: nothing is turned on, minted or sent', async () => {
  const calls = [];
  const bridge = {pushStatus: async () => (calls.push('status'), {ok: true, push: OFF}), pushSet: async (op) => { calls.push(op); return {ok: true, push: ON}; }};
  const P = load(bridge);
  P.phonePushAct('refresh');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ['status']);
  // Off, a stray test, copy or New address does nothing.
  P.phonePushAct('test'); P.phonePushAct('copy'); P.phonePushAct('newTopic'); P.phonePushAct('newTopic');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ['status']);
  assert.equal(P.PUSH.state.enabled, false);
});

test('Set up runs push on; the switch turns it off; Send test runs test; New address takes two clicks', async () => {
  const calls = [];
  const bridge = {pushStatus: async () => ({ok: true, push: OFF}), pushSet: async (op) => { calls.push(op); return {ok: true, push: op === 'off' ? OFF : ON}; }};
  const P = load(bridge);
  P.PUSH.state = OFF;
  P.phonePushAct('setup');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ['on']);
  assert.equal(P.PUSH.state.enabled, true);
  P.phonePushAct('setup');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ['on'], 'Set up again once set up does nothing');
  P.phonePushAct('test');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ['on', 'test']);
  assert.equal(P.PUSH.msg, 'Sent. Did it arrive on your phone?');
  P.phonePushAct('newTopic');
  assert.deepEqual(calls, ['on', 'test'], 'first click only arms');
  P.phonePushAct('newTopic');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ['on', 'test', 'newTopic']);
  P.phonePushAct('enable');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ['on', 'test', 'newTopic', 'off']);
  assert.equal(P.PUSH.state.enabled, false);
});

test('analytics keeps the pane verbs and drops anything after them', () => {
  const ctx = vm.createContext({window:{}});
  vm.runInContext(readFileSync(new URL('../renderer/analytics-acts.js', import.meta.url), 'utf8'), ctx);
  const {sanitizeAct} = vm.runInContext('ANX_ACTS', ctx);
  for (const v of ['copy', 'enable', 'newTopic', 'refresh', 'setup', 'test']) assert.equal(sanitizeAct('push:' + v), 'push:' + v);
});

test('main: argv per op, config lock for writes, the config block as the pane reads it, and the turn ping', () => {
  const M = require('../out/main/push-cli.js');
  assert.deepEqual(M.pushCliArgs('on'), ['push', 'on']);
  assert.deepEqual(M.pushCliArgs('newTopic'), ['push', 'on', '--new-topic']);
  assert.equal(M.parsePushOp('rm -rf'), null);
  assert.equal(M.pushOpWritesConfig('test'), false);
  assert.equal(M.pushOpWritesConfig('off'), true);
  assert.equal(M.isUnsupportedPushCli('unknown command: push'), true);
  assert.deepEqual(M.parsePushState({enabled: true, server: 'https://ntfy.sh/', topic: 'atag-abc', tokenEnv: 'NTFY_TOKEN'}),
    {enabled: true, server: 'https://ntfy.sh', topic: 'atag-abc', tokenEnv: 'NTFY_TOKEN', subscribeUrl: 'https://ntfy.sh/atag-abc'});
  assert.equal(M.parsePushState('nope'), null);
  assert.equal(M.turnPushRequest(OFF, {title: 't', body: 'b'}, undefined), null);
  const req = M.turnPushRequest(ON, {title: 'Turn failed', body: 'x'.repeat(500)}, 'tk_1');
  assert.equal(req.url, 'https://ntfy.sh/');
  assert.equal(req.init.headers.authorization, 'Bearer tk_1');
  const body = JSON.parse(req.init.body);
  assert.equal(body.topic, 'atag-abc');
  assert.equal(Array.from(body.message).length, 200);
  assert.equal(body.priority, 4);
});
