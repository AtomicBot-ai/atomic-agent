// ATO-2736: the mini chat says why it opened without the selected text.
// The read with its reason (main/selected-text-grab.ts, against the built
// output), the line the page draws (renderer/mini-chat-notice.js), the
// Settings row's Accessibility button and its re-check on focus
// (renderer/quick-entry-settings.js), and the wiring (read from the sources).
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('../out/main/selected-text-grab.js');
const T = require('../out/main/selected-text.js');
const N = require('../renderer/mini-chat-notice.js');
const Q = require('../renderer/quick-entry-settings.js');
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const UNSET = {use: null, translateTo: null};
const ON = {use: true, translateTo: null};
const OFF = {use: false, translateTo: null};
const deps = (over) => Object.assign({
  pref: ON, platform: 'darwin', trusted: true, withFrontApp: false,
  readText: async () => 'hello', readFrontApp: async () => null,
}, over);

test('why the hotkey will not read: permission on macOS unless the user turned it off', () => {
  assert.equal(T.selectedTextSkip(ON, 'darwin', true), null);
  assert.equal(T.selectedTextSkip(UNSET, 'darwin', true), null);
  assert.equal(T.selectedTextSkip(ON, 'darwin', false), 'permission', 'a stale permission after an update');
  assert.equal(T.selectedTextSkip(UNSET, 'darwin', false), 'permission', 'never allowed: the switch never saved');
  assert.equal(T.selectedTextSkip(OFF, 'darwin', false), 'off', 'turned off by the user: not a permission problem');
  assert.equal(T.selectedTextSkip(OFF, 'darwin', true), 'off');
  assert.equal(T.selectedTextSkip(UNSET, 'win32', true), 'off', 'Windows and Linux: off until turned on, no permission');
  assert.equal(T.selectedTextSkip(ON, 'linux', true), null);
});

test('the read gives a reason instead of a bare null', async () => {
  assert.deepEqual(await G.grabSelectionWith(deps()), {selection: {text: 'hello', app: null}, miss: null});
  let read = 0;
  const counted = deps({trusted: false, readText: async () => { read++; return 'x'; }});
  assert.deepEqual(await G.grabSelectionWith(counted), {selection: null, miss: 'permission'});
  assert.equal(read, 0, 'no copy keys pressed without the permission');
  assert.deepEqual(await G.grabSelectionWith(deps({pref: OFF})), {selection: null, miss: 'off'});
  assert.deepEqual(await G.grabSelectionWith(deps({readText: async () => null})), {selection: null, miss: 'empty'});
  assert.deepEqual(await G.grabSelectionWith(deps({readText: async () => { throw new Error('timeout'); }})), {selection: null, miss: 'failed'});
});

test('the app in front comes with the text for Replace, and its failure never holds the text back', async () => {
  const app = {pid: 7, name: 'Notes'};
  assert.deepEqual((await G.grabSelectionWith(deps({withFrontApp: true, readFrontApp: async () => app}))).selection, {text: 'hello', app});
  assert.deepEqual((await G.grabSelectionWith(deps({withFrontApp: true, readFrontApp: async () => { throw new Error('no'); }}))).selection, {text: 'hello', app: null});
});

test('a line only for permission and a failed read; Settings only where it fixes it', () => {
  assert.equal(G.selectionMissNotice(null), null);
  assert.equal(G.selectionMissNotice('off'), null, "the user's own choice");
  assert.equal(G.selectionMissNotice('empty'), null, 'nothing was selected');
  const perm = G.selectionMissNotice('permission');
  assert.equal(perm.settings, true);
  assert.match(perm.text, /Accessibility/);
  const failed = G.selectionMissNotice('failed');
  assert.equal(failed.settings, false);
  assert.match(failed.text, /paste it here/);
  for (const n of [perm, failed]) assert.doesNotMatch(n.text, /—/, 'no long dash');
});

test('the page draws main\'s line with an Open Settings button', () => {
  assert.equal(N.mcSelectionNoticeView(null), null);
  assert.equal(N.mcSelectionNoticeView({text: ''}), null);
  assert.deepEqual(N.mcSelectionNoticeView({text: 'a', settings: true}), {text: 'a', tone: 'warn', button: 'Open Settings', act: 'settings'});
  assert.deepEqual(N.mcSelectionNoticeView({text: 'b', settings: false}), {text: 'b', tone: 'warn', button: null, act: null});
});

test('the mini chat is wired: notice from main, the line in the page, Settings › General in the main window', () => {
  const qw = src('../main/quick-entry-window.ts');
  assert.match(qw, /create\(grab\.selection, selectionMissNotice\(grab\.miss\)\)/);
  assert.match(qw, /selection, notice \}\)\)/);
  assert.match(qw, /ipcMain\.handle\("app:quickEntryOpenSettings"/);
  assert.match(qw, /main\.webContents\.send\("app:menu", "settings:general"\)/);
  assert.match(src('../preload/preload.ts'), /quickEntryOpenSettings: \(\) => ipcRenderer\.invoke\("app:quickEntryOpenSettings"\)/);
  const html = src('../renderer/mini-chat.html');
  assert.match(html, /id="mc-notice"[^>]*hidden/);
  assert.ok(html.indexOf('mini-chat-notice.js') > 0 && html.indexOf('mini-chat-notice.js') < html.indexOf('mini-chat.js"'), 'loaded before the page script');
  assert.match(src('../renderer/mini-chat.js'), /mcSelectionNotice\(opened\.notice, BR\)/);
  assert.match(src('../main/selected-text-ipc.ts'), /grabSelectionWith\(\{/);
});

test('Settings: the hint says what to do when the entry is already on, with a button to the pane', () => {
  assert.match(T.SELECTED_TEXT_ACCESSIBILITY_HINT, /If Atomic Agent is already on in the list, remove it with − and add it again, then restart the app\./);
  const h = {esc: (s) => String(s), setSwitchHTML: () => '<i></i>'};
  const mac = Q.qeSelectionRowHTML(T.selectedTextInfo(ON, 'darwin', false), false, h);
  assert.match(mac, /data-act="quickentry:accessibility">Open Accessibility settings</);
  for (const info of [T.selectedTextInfo(ON, 'darwin', true), T.selectedTextInfo(ON, 'win32', true), T.selectedTextInfo(ON, 'linux', true)]) {
    assert.doesNotMatch(Q.qeSelectionRowHTML(info, false, h), /Open Accessibility settings/, 'no button once allowed, none off macOS');
  }
  const qs = src('../renderer/quick-entry-settings.js');
  assert.match(qs, /v === 'accessibility'\) \{ if \(BR\.showOnceOpenAccessibility\) BR\.showOnceOpenAccessibility\(\)/, "Show once's IPC, reused");
});

test('focus re-checks the permission while the row is on screen, so the hint goes without a restart', async () => {
  let asked = 0, painted = 0;
  const allowed = {ok: true, on: true, hint: null, openAccessibility: false, translateTo: null};
  const br = {selectedTextGet: async () => { asked++; return allowed; }};
  Q.QE.sel = T.selectedTextInfo(ON, 'darwin', false);
  assert.equal(Q.qeRecheckTrust(br, () => false, () => painted++), false, 'another pane: nothing asked');
  assert.equal(asked, 0);
  assert.equal(Q.qeRecheckTrust(br, () => true, () => painted++), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(asked, 1);
  assert.equal(painted, 1, 'the hint went: repainted');
  assert.equal(Q.QE.sel.hint, null);
  Q.qeRecheckTrust(br, () => true, () => painted++);
  await new Promise((r) => setImmediate(r));
  assert.equal(painted, 1, 'nothing changed: no repaint');
  assert.match(src('../renderer/quick-entry-settings.js'), /window\.addEventListener\('focus', \(\) => qeRecheckTrust\(BR,/);
});
