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
  assert.match(source, /\['connections','Connections','plug',\['mcp','telegram','push','composio'\]\]/);
  assert.match(source, /\['telegram','Telegram'\],\['push','Phone push'\],\['composio','Composio'\]/);
  assert.match(source, /\['bell','Phone push','Settings · Connections','','settings:push'\]/);
  for (const hook of ["pane === 'push') phonePushTabEntered()", "p === 'push') return pushTab()",
    "k === 'push') { close(); phonePushAct(a.slice(5))"]) {
    assert.ok(source.includes(hook), hook);
  }
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const helper = index.indexOf('<script src="phone-push.js">');
  assert.ok(helper > 0 && helper < index.indexOf('<script src="renderer.js">'));
});

test('off: the switch, no topic; on: the subscribe URL, the public-topic warning and Send test', () => {
  const P = load(null);
  const off = P.phonePushPaneHTML({state: OFF, busy: null}, h);
  assert.match(off, /data-act="push:enable"/);
  assert.match(off, /aria-checked="false"/);
  assert.doesNotMatch(off, /atag-abc/);
  assert.doesNotMatch(off, /push:test/);
  const on = P.phonePushPaneHTML({state: ON, busy: null}, h);
  assert.match(on, /aria-checked="true"/);
  assert.match(on, /https:\/\/ntfy\.sh\/atag-abc/);
  assert.match(on, /public by name/);
  assert.match(on, /data-act="push:test"/);
  assert.match(P.phonePushPaneHTML({state: Object.assign({}, ON, {server:'https://ntfy.example.com', subscribeUrl:'https://ntfy.example.com/atag-abc'}), busy: null}, h), /Pings go to ntfy\.example\.com/);
  assert.match(P.phonePushPaneHTML({state: null, unsupported: true, err: 'update'}, h), /needs a newer agent/);
  assert.doesNotMatch(on + off, /—/);
});

test('the switch runs push on when off and push off when on; Send test runs test; New topic takes two clicks', async () => {
  const calls = [];
  const bridge = {pushStatus: async () => ({ok: true, push: OFF}), pushSet: async (op) => { calls.push(op); return {ok: true, push: op === 'off' ? OFF : ON}; }};
  const P = load(bridge);
  P.PUSH.state = OFF;
  P.phonePushAct('enable');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ['on']);
  assert.equal(P.PUSH.state.enabled, true);
  P.phonePushAct('enable');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ['on', 'off']);
  P.phonePushAct('test');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ['on', 'off', 'test']);
  assert.match(P.PUSH.msg, /Test ping sent/);
  P.phonePushAct('newTopic');
  assert.deepEqual(calls, ['on', 'off', 'test'], 'first click only arms');
  P.phonePushAct('newTopic');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ['on', 'off', 'test', 'newTopic']);
});

test('a failed write says why and leaves the state as read', async () => {
  const P = load({pushSet: async () => ({ok: false, error: 'ntfy answered 403'})});
  P.PUSH.state = ON;
  P.phonePushAct('test');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(P.PUSH.err, 'ntfy answered 403');
  assert.equal(P.PUSH.state, ON);
});

test('analytics keeps the pane verbs and drops anything after them', () => {
  const ctx = vm.createContext({window:{}});
  vm.runInContext(readFileSync(new URL('../renderer/analytics-acts.js', import.meta.url), 'utf8'), ctx);
  const {sanitizeAct} = vm.runInContext('ANX_ACTS', ctx);
  for (const v of ['enable', 'newTopic', 'refresh', 'test']) assert.equal(sanitizeAct('push:' + v), 'push:' + v);
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
