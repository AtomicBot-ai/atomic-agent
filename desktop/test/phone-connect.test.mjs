// Settings › Connections › Connect phone (ATO-2493): the pane markup and its
// verbs (renderer/phone-connect.js), and where it sits in Settings.
// No request leaves the process: the bridge is a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ic = (n) => '<i:' + n + '>';
const qr = (text) => '<svg data-qr="' + esc(text) + '"></svg>';
const h = {esc, ic, qr};

const OFF = {ok: true, remote: false, enabled: false, listening: false, addresses: []};
const ON = {ok: true, remote: false, enabled: true, listening: true, addresses: ['http://192.168.1.20:19193']};
const base = (over) => Object.assign({status: null, err: null, busy: null, pairing: null, devices: [], devicesErr: null, confirmRevoke: null, now: Date.parse('2026-11-27T12:00:00Z')}, over);

function load(bridge) {
  const ctx = vm.createContext({BR: bridge, render: () => {}, esc, ic, module: {exports: {}}, Date, Promise, Object, String, Number, Math});
  vm.runInContext(readFileSync(new URL('../renderer/phone-connect.js', import.meta.url), 'utf8'), ctx);
  return ctx.module.exports;
}
const M = load(null);

test('Connect phone sits after Phone push in Connections, in the tab list and the palette', () => {
  assert.match(source, /\['connections','Connections','plug',\['mcp','telegram','discord','push','phone','composio','monid'\]\]/);
  assert.match(source, /\['push','Phone push'\],\['phone','Connect phone'\],\['composio','Composio'\]/);
  assert.match(source, /\['plug','Connect phone','Settings · Connections','','settings:phone'\]/);
  for (const hook of ["pane === 'phone') phoneTabEntered()", "p === 'phone') return phoneTab()",
    "k === 'phone') { close(); phoneConnectAct(a.slice(6))"]) {
    assert.ok(source.includes(hook), hook);
  }
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = index.indexOf('<script src="phone-connect.js">');
  assert.ok(at > 0 && at < index.indexOf('<script src="renderer.js">'));
  assert.ok(index.indexOf('<script src="qr-code.js">') < index.indexOf('<script src="renderer.js">'));
});

test('loading, then off: the switch is off and nothing offers a code', () => {
  assert.match(M.phoneConnectPaneHTML(base({}), h), /Loading/);
  const off = M.phoneConnectPaneHTML(base({status: OFF}), h);
  assert.match(off, /role="switch" aria-checked="false" aria-label="Allow phones on this Wi-Fi"/);
  assert.match(off, /only this computer can reach the agent/);
  assert.doesNotMatch(off, /data-act="phone:pair"/);
});

test('on: the warning, Pair a phone, the firewall line; a pairing shows the QR of the link and the short code', () => {
  const on = M.phoneConnectPaneHTML(base({status: ON}), h);
  assert.match(on, /aria-checked="true"/);
  assert.match(on, /not encrypted/);
  assert.match(on, /data-act="phone:pair"/);
  assert.match(on, /data-phone-firewall/);
  const paired = M.phoneConnectPaneHTML(base({status: ON, pairing: {url: 'http://192.168.1.20:19193/pair/abc', code: 'BCDF-GHJK', expiresAt: '2026-11-27T12:05:00Z', others: ['http://10.0.0.5:19193/panel']}}), h);
  assert.match(paired, /data-qr="http:\/\/192\.168\.1\.20:19193\/pair\/abc"/);
  assert.match(paired, /data-phone-code[^>]*>BCDF-GHJK</);
  assert.match(paired, /Connect this app/);
  assert.match(paired, /10\.0\.0\.5:19193\/panel/);
  assert.match(paired, /New code/);
});

test('on but the agent not yet listening says so, with Check again', () => {
  const out = M.phoneConnectPaneHTML(base({status: Object.assign({}, ON, {listening: false, addresses: []})}), h);
  assert.match(out, /data-phone-waiting/);
  assert.match(out, /data-act="phone:refresh"/);
  assert.doesNotMatch(out, /data-act="phone:pair"/);
});

test('devices: empty, a list with last seen and Sign out, and an error with Details', () => {
  assert.match(M.phoneConnectPaneHTML(base({status: ON, devices: []}), h), /No phones paired yet/);
  const list = M.phoneConnectPaneHTML(base({status: ON, devices: [{id: 'aaaaaaaa', name: 'iPhone', createdAt: '2026-11-01', lastSeenAt: '2026-11-27T09:00:00Z'}]}), h);
  assert.match(list, /iPhone/);
  assert.match(list, /Last seen 3 hours ago/);
  assert.match(list, /data-act="phone:revoke:aaaaaaaa"[^>]*>Sign out</);
  const armed = M.phoneConnectPaneHTML(base({status: ON, confirmRevoke: 'aaaaaaaa', devices: [{id: 'aaaaaaaa', name: 'iPhone', createdAt: 'x', lastSeenAt: 'x'}]}), h);
  assert.match(armed, /Click again to sign out/);
  const err = M.phoneConnectPaneHTML(base({status: ON, devices: null, devicesErr: {error: 'Could not load the paired phones.', detail: 'EACCES'}}), h);
  assert.match(err, /Could not load the paired phones\./);
  assert.match(err, /<details[^>]*><summary>Details<\/summary>.*EACCES/);
});

test('a remote agent: pair on that computer, no switch', () => {
  const out = M.phoneConnectPaneHTML(base({status: Object.assign({}, OFF, {remote: true})}), h);
  assert.match(out, /atag pair there/);
  assert.doesNotMatch(out, /role="switch"/);
});

test('the verbs: only known ones, and a revoke id must look like one', () => {
  assert.deepEqual({...M.phoneParseAct('enable')}, {verb: 'enable', arg: ''});
  assert.deepEqual({...M.phoneParseAct('revoke:aaaaaaaa')}, {verb: 'revoke', arg: 'aaaaaaaa'});
  assert.equal(M.phoneParseAct('revoke:all'), null);
  assert.equal(M.phoneParseAct('format-disk'), null);
});

test('the switch flips the saved value; Sign out takes two clicks; Pair only while listening', async () => {
  const calls = [];
  const bridge = {
    phoneStatus: async () => ON,
    phoneDevices: async () => ({ok: true, devices: []}),
    phoneSetEnabled: async (v) => { calls.push('set:' + v); return Object.assign({}, ON, {enabled: v}); },
    phonePair: async () => { calls.push('pair'); return {ok: true, url: 'u', code: 'BCDF-GHJK', expiresAt: 'x', others: []}; },
    phoneRevoke: async (id) => { calls.push('revoke:' + id); return {ok: true}; },
  };
  const R = load(bridge);
  R.PHONE.status = OFF;
  await R.phoneConnectAct('enable');
  assert.deepEqual(calls, ['set:true']);
  R.PHONE.status = Object.assign({}, ON, {listening: false});
  R.phoneConnectAct('pair');
  assert.deepEqual(calls, ['set:true'], 'no pairing before the agent listens');
  R.PHONE.status = ON;
  await R.phoneConnectAct('pair');
  assert.equal(R.PHONE.pairing.code, 'BCDF-GHJK');
  R.phoneConnectAct('revoke:aaaaaaaa');
  assert.equal(calls.includes('revoke:aaaaaaaa'), false, 'the first click only arms it');
  await R.phoneConnectAct('revoke:aaaaaaaa');
  assert.ok(calls.includes('revoke:aaaaaaaa'));
});
