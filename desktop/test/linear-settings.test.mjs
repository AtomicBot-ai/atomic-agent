// Settings › Connections › Linear (ATO-2464), renderer side: the input rules,
// the effective `channels.linear` block, the actions against a fake bridge,
// the pane's markup in its loading, empty, error and set-up states, and the
// wiring read as text. Helpers come from renderer/linear-settings.js and
// renderer/linear-pane.js. Every key and id here is a dummy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../renderer/linear-settings.js');
const P = require('../renderer/linear-pane.js');
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const h = {esc, ic: (n) => '<i data-ic="' + n + '"></i>'};
const KEY = 'lin_api_dummy0123456789abcdefghijklmnop';
const SECRET = 'lin_wh_dummy0123456789abcdefghij';
const ME = '2f1c0a4e-1b2c-4d5e-8f90-123456789abc';
const OTHER = '3f1c0a4e-1b2c-4d5e-8f90-123456789abc';
const RAW = 'EACCES: /Users/someone/.atomic-agent/.env';

function fakeApi(start = {}) {
  const calls = [];
  const s = {linear: start.linear, names: start.names || [], gen: 1, fail: start.fail || {}, check: start.check || {ok:true, viewer:{id:ME, name:'Nadia'}}};
  const api = {
    readConfig: async () => (calls.push(['readConfig']), s.fail.read ? {ok:false, error:RAW} : {ok:true, value: s.linear ? {linear: JSON.parse(JSON.stringify(s.linear))} : {}}),
    secretsPresent: async () => ({ok:true, names:s.names.slice()}),
    setSecret: async (name, v) => {
      calls.push(['setSecret', name, v === null ? null : 'VALUE']);
      if (s.fail.secret) return {ok:false, error:RAW};
      s.names = v === null ? s.names.filter((n) => n !== name) : Array.from(new Set(s.names.concat([name])));
      return {ok:true};
    },
    checkKey: async () => (calls.push(['checkKey']), s.check),
    write: async (block) => { calls.push(['write', block]); if (s.fail.write) return {ok:false, error:RAW}; s.linear = block; return {ok:true}; },
    restart: async () => (calls.push(['restart']), s.gen++, {state:'connected'}),
    restartBlocked: () => false,
    agentGen: () => s.gen,
  };
  return {api, calls, s};
}
const view = (ctrl) => ({status: L.lnStatus(ctrl.state, ctrl.restartOwed()), mode: L.lnMode(ctrl.state.cfg, ctrl.state.hasSecret),
  mention: L.lnMention(ctrl.state.cfg), owed: ctrl.restartOwed(), stale: false});

test('input rules: keys, user ids and handles', () => {
  assert.equal(L.lnSecretClean(' ' + KEY + ' ', 'API key').value, KEY);
  assert.equal(L.lnSecretClean('', 'API key').ok, false);
  assert.equal(L.lnSecretClean('two words key here and more', 'API key').ok, false);
  assert.equal(L.lnIdClean(ME.toUpperCase()).value, ME);
  assert.equal(L.lnIdClean('me').ok, false);
  assert.equal(L.lnMentionClean('@Agent, atomic ,agent').value, 'agent,atomic');
  assert.equal(L.lnMentionClean('bad handle!').ok, false);
});

test('the block as the agent reads it, and the mode it resolves', () => {
  assert.deepEqual(L.lnReadBlock({}), {enabled:false, ownerIds:[], options:{}});
  const b = L.lnReadBlock({linear:{enabled:true, ownerIds:[ME, 'nope', ME], options:{port:4000}}});
  assert.deepEqual(b, {enabled:true, ownerIds:[ME], options:{port:4000}});
  assert.equal(L.lnMode(b, false), 'poll');
  assert.equal(L.lnMode(b, true), 'webhook', 'no explicit mode: webhook when the secret is saved');
  assert.equal(L.lnMode({options:{mode:'poll'}}, true), 'poll');
});

test('a key is checked with Linear first; its user becomes the owner, polling is the default, and the key stays out of state', async () => {
  const {api, calls, s} = fakeApi();
  const c = L.createLinearSettings(api);
  await c.entered();
  assert.equal((await c.saveKey(KEY)).ok, true);
  assert.deepEqual(calls.filter((x) => x[0] !== 'readConfig').slice(0, 2), [['checkKey'], ['setSecret', 'LINEAR_API_KEY', 'VALUE']]);
  assert.deepEqual(s.linear, {enabled:true, ownerIds:[ME], options:{mode:'poll'}});
  assert.equal(c.restartOwed(), true);
  assert.match(c.state.message, /Connected as Nadia/);
  assert.ok(!JSON.stringify(c.state).includes(KEY));
  assert.ok(!P.linearPaneHTML(c.state, view(c), h).includes(KEY));
});

test('a key Linear refuses, or cannot check, is not saved, and the words are ours', async () => {
  for (const [check, re] of [[{ok:false, reason:'rejected'}, /did not accept/], [{ok:false, reason:'unreachable'}, /Could not reach Linear/]]) {
    const {api, calls} = fakeApi({check});
    const c = L.createLinearSettings(api);
    await c.entered();
    c.openKey();
    assert.equal((await c.saveKey(KEY)).ok, false);
    assert.ok(!calls.some((x) => x[0] === 'setSecret' || x[0] === 'write'), 'nothing written');
    assert.match(c.state.keyError, re);
    assert.equal(c.state.mode, 'keyPrompt');
  }
});

test('a failed write says so without the raw error text', async () => {
  const {api} = fakeApi({names:['LINEAR_API_KEY'], linear:{enabled:true, ownerIds:[ME], options:{}}, fail:{write:true}});
  const c = L.createLinearSettings(api);
  await c.entered();
  await c.setEnabled(false);
  assert.equal(c.state.lastError, L.LN_SAVE_FAILED);
  const html = P.linearPaneHTML(c.state, view(c), h);
  assert.ok(!html.includes('EACCES') && !html.includes('/Users/'), 'no raw error text in the pane');
});

test('webhook asks for the signing secret first, then switches; removing the secret goes back to polling', async () => {
  const {api, s} = fakeApi({names:['LINEAR_API_KEY'], linear:{enabled:true, ownerIds:[ME], options:{mode:'poll', port:4000}}});
  const c = L.createLinearSettings(api);
  await c.entered();
  await c.setMode('webhook');
  assert.equal(c.state.mode, 'secretPrompt');
  assert.equal(s.linear.options.mode, 'poll', 'not switched before the secret is saved');
  await c.saveSecret(SECRET);
  assert.deepEqual(s.linear.options, {mode:'webhook', port:4000}, 'other options kept');
  assert.equal(L.lnStatus(c.state, false).on, true);
  c.arm('clearSecret', 0);
  await c.clearSecret();
  assert.equal(s.linear.options.mode, 'poll');
  assert.ok(!s.names.includes('LINEAR_WEBHOOK_SECRET'));
});

test('owners: added once, checked, removed; handle saved', async () => {
  const {api, s} = fakeApi({names:['LINEAR_API_KEY'], linear:{enabled:true, ownerIds:[ME], options:{}}});
  const c = L.createLinearSettings(api);
  await c.entered();
  assert.equal((await c.addOwner('nope')).ok, false);
  assert.match(c.state.idError, /Linear user id/);
  assert.equal((await c.addOwner(ME)).ok, false);
  assert.equal((await c.addOwner(OTHER)).ok, true);
  assert.deepEqual(s.linear.ownerIds, [ME, OTHER]);
  await c.removeOwner(ME);
  assert.deepEqual(s.linear.ownerIds, [OTHER]);
  c.setDraftMention('@Atomic');
  await c.saveMention();
  assert.equal(s.linear.options.mention, 'atomic');
});

test('the pane: loading, read failure, connect card, and the set-up rows', async () => {
  const fresh = L.createLinearSettings(fakeApi().api);
  assert.match(P.linearPaneHTML(fresh.state, view(fresh), h), /data-ln-loading/);
  const broken = L.createLinearSettings(fakeApi({fail:{read:true}}).api);
  await broken.entered();
  const bhtml = P.linearPaneHTML(broken.state, view(broken), h);
  assert.match(bhtml, /data-ln-load-failed/);
  assert.match(bhtml, /data-act="linear:refresh"/);
  assert.ok(!bhtml.includes('EACCES'));
  await fresh.entered();
  assert.match(P.linearPaneHTML(fresh.state, view(fresh), h), /data-ln-connect[\s\S]*data-act="linear:key"/);
  const {api} = fakeApi({names:['LINEAR_API_KEY'], linear:{enabled:true, ownerIds:[], options:{}}});
  const c = L.createLinearSettings(api);
  await c.entered();
  const html = P.linearPaneHTML(c.state, view(c), h);
  assert.match(html, /data-ln-owners-empty/);
  assert.match(html, /data-ln-status="off"/);
  assert.match(html, /data-act="linear:mode:webhook"/);
});

test('wiring: scripts, tab after Discord, routes, the allowed .env names, the key check and the smoke list', () => {
  const index = src('../renderer/index.html');
  const at = (s) => index.indexOf(s);
  assert.ok(at('<script src="linear-settings.js">') > 0 && at('<script src="linear-settings.js">') < at('<script src="renderer.js">'));
  assert.ok(at('<script src="linear-pane.js">') < at('<script src="renderer.js">'));
  assert.ok(at('<script src="linear-tab.js">') > at('<script src="renderer.js">'));
  const r = src('../renderer/renderer.js');
  assert.match(r, /SETTINGS_TABS\.splice\(SETTINGS_TABS\.findIndex\(\(t\) => t\[0\] === 'discord'\) \+ 1, 0, \['linear','Linear'\]\);/);
  assert.match(r, /if \(p === 'linear'\) return linearTab\(\);/);
  assert.match(r, /if \(k === 'linear'\) \{ close\(\); linearAct\(a\.slice\(7\)\); return; \}/);
  assert.match(r, /else if \(pane === 'linear'\) linearTabEntered\(\);/);
  const tab = src('../renderer/linear-tab.js');
  assert.match(tab, /BR\.configSetPath\('channels\.linear', block\)/);
  assert.match(tab, /BR\.linearCheckKey\(v\)/);
  assert.match(src('../preload/preload.ts'), /linearCheckKey: \(value: string\) => ipcRenderer\.invoke\("linear:checkKey", \{ value \}\)/);
  const main = src('../main/main.ts');
  assert.match(main, /ipcMain\.handle\("linear:checkKey"/);
  assert.match(main, /"discord", "linear", "push"/);
  assert.match(src('../main/agent-cli.ts'), /"DISCORD_BOT_TOKEN", "LINEAR_API_KEY", "LINEAR_WEBHOOK_SECRET"\]/);
});
