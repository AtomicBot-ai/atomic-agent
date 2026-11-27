// ATO-2268: the mini chat's answer put back in place of the selected text,
// in the app it came from ("Replace in Safari"). The pure half
// (main/replace-selection.ts, against the built output) with fakes, the
// page's button (renderer/mini-chat-selection.js), and the wiring in
// quick-entry-window.ts, selected-text-ipc.ts and mini-chat.js (read from
// the sources).
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../out/main/replace-selection.js');
const T = require('../out/main/selected-text.js');
const S = require('../renderer/mini-chat-selection.js');
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const SAFARI = {name: 'Safari', pid: 4242};

/** Fakes that log each step in order; a test swaps any of them. */
function fakes() {
  const log = [];
  const deps = {
    allowed: (prompt) => { log.push('allowed:' + prompt); return true; },
    hide: () => { log.push('hide'); },
    // ATO-2750: false = the mini chat is gone, as before; the tests that bring it back say so.
    bringBack: () => { log.push('back'); return false; },
    close: () => { log.push('close'); },
    activate: async (app) => { log.push('activate:' + app.pid); return true; },
    sleep: async (ms) => { log.push('sleep:' + ms); },
    paste: async (text) => { log.push('paste:' + text); return {pasted: true, restored: true}; },
    copy: (text) => { log.push('copy:' + text); },
    notify: (line) => { log.push('notify'); deps.lines.push(line); },
    lines: [],
  };
  return {deps, log};
}

test('the steps in order: check, hide the mini chat, bring the app back, wait, paste', async () => {
  const {deps, log} = fakes();
  const out = await R.replaceInSourceApp(deps, SAFARI, '  Better words.\r\nSecond line. ');
  assert.deepEqual(out, {ok: true, restored: true});
  assert.deepEqual(log, ['allowed:false', 'hide', 'activate:4242', 'sleep:150', 'paste:Better words.\nSecond line.', 'close']);
});

test('the paste is the clipboard-keeping one: a real ClipboardHost fake sees save, write, put back', async () => {
  const K = require('../out/main/keystroke-clipboard.js');
  const box = {text: 'my own copy'};
  const steps = [];
  const host = {
    save: () => { steps.push('save'); return box.text; },
    restore: (s) => { steps.push('restore'); box.text = s; },
    readText: () => box.text,
    writeText: (t) => { steps.push('write'); box.text = t; },
    clear: () => { box.text = ''; },
  };
  const press = async (kind) => { steps.push('press:' + kind); return true; };
  const {deps, log} = fakes();
  deps.paste = (text) => K.pasteByKeystroke(host, {press, sleep: async () => {}}, text);
  const out = await R.replaceInSourceApp(deps, SAFARI, 'Answer');
  assert.deepEqual(out, {ok: true, restored: true});
  assert.deepEqual(steps, ['save', 'write', 'press:paste', 'restore']);
  assert.equal(box.text, 'my own copy', 'the user\'s clipboard is back');
  assert.ok(log.indexOf('activate:4242') < log.indexOf('sleep:150'), 'the app is in front before any key');
});

test('no Accessibility: macOS is asked, the mini chat stays and says why, nothing is pressed', async () => {
  const asked = [];
  const {deps, log} = fakes();
  deps.allowed = (prompt) => { asked.push(prompt); return false; };
  const out = await R.replaceInSourceApp(deps, SAFARI, 'Answer');
  assert.deepEqual(out, {ok: false, hidden: false, error: T.SELECTED_TEXT_ACCESSIBILITY_HINT});
  assert.equal(R.REPLACE_ACCESSIBILITY_HINT, T.SELECTED_TEXT_ACCESSIBILITY_HINT, 'the same line as the Settings switch');
  assert.deepEqual(asked, [false, true]);
  assert.deepEqual(log, [], 'no hide, no activate, no paste');
});

test('the app could not be brought back: no key pressed, the answer left on the clipboard, a notification', async () => {
  const {deps, log} = fakes();
  deps.activate = async () => { log.push('activate'); return false; };
  const out = await R.replaceInSourceApp(deps, SAFARI, 'Answer');
  assert.equal(out.ok, false);
  assert.equal(out.hidden, true);
  assert.match(out.error, /Safari/);
  assert.deepEqual(log, ['allowed:false', 'hide', 'activate', 'copy:Answer', 'back', 'notify']);
  assert.ok(!log.some((l) => l.startsWith('paste')));
  const threw = fakes();
  threw.deps.activate = async () => { throw new Error('osascript'); };
  assert.equal((await R.replaceInSourceApp(threw.deps, SAFARI, 'x')).ok, false);
  assert.ok(!threw.log.some((l) => l.startsWith('paste')));
});

test('a paste that did not go: the line says the answer is on the clipboard', async () => {
  const {deps} = fakes();
  deps.paste = async () => ({pasted: false, reason: 'no-keystroke'});
  const out = await R.replaceInSourceApp(deps, SAFARI, 'Answer');
  assert.deepEqual(out, {ok: false, hidden: true, error: 'The answer is on the clipboard: press ⌘V in Safari.'});
  assert.deepEqual(deps.lines, [out.error]);
  const broke = fakes();
  broke.deps.paste = async () => { throw new Error('x'); };
  assert.equal((await R.replaceInSourceApp(broke.deps, SAFARI, 'Answer')).hidden, true);
});

test('nothing to put back, or no app known: the mini chat stays and says so', async () => {
  for (const raw of ['', '   ', null, 42, 'x'.repeat(R.REPLACE_MAX_CHARS + 1)]) {
    const {deps, log} = fakes();
    const out = await R.replaceInSourceApp(deps, SAFARI, raw);
    assert.equal(out.ok, false, String(raw).slice(0, 10));
    assert.equal(out.hidden, false);
    assert.deepEqual(log, []);
  }
  const {deps, log} = fakes();
  assert.equal((await R.replaceInSourceApp(deps, null, 'Answer')).hidden, false);
  assert.deepEqual(log, []);
});

test('which app to bring back: the front-app read, checked, never this app itself', () => {
  assert.deepEqual(R.parseFrontApp('{"name":"Safari","pid":4242}\n', 1), SAFARI);
  assert.equal(R.parseFrontApp('{"name":"Atomic Agent","pid":77}', 77), null, 'our own window was in front');
  assert.deepEqual(R.parseFrontApp('{"name":"  ","pid":9}', 1), {name: 'the app', pid: 9});
  assert.equal(R.parseFrontApp('{"name":"Notes  App\\n","pid":9}', 1).name, 'Notes App');
  for (const bad of ['', 'nope', '{"name":"x"}', '{"name":"x","pid":-1}', '{"name":"x","pid":1.5}', '{"name":"x","pid":"9"}', 'null', null]) {
    assert.equal(R.parseFrontApp(bad, 1), null, String(bad));
  }
});

test('the commands: macOS only, JavaScript for Automation, a pid that is a number', () => {
  const front = R.frontAppCommand('darwin');
  assert.equal(front.file, '/usr/bin/osascript');
  assert.deepEqual(front.args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.match(front.args[3], /NSWorkspace\.sharedWorkspace\.frontmostApplication/);
  const act = R.activateAppCommand('darwin', 4242);
  assert.match(act.args[3], /runningApplicationWithProcessIdentifier\(4242\)/);
  assert.match(act.args[3], /activateWithOptions\(2\)/);
  assert.equal(R.activateAppCommand('darwin', '4242; do shell script'), null);
  assert.equal(R.activateAppCommand('darwin', 0), null);
  for (const p of ['win32', 'linux']) {
    assert.equal(R.frontAppCommand(p), null);
    assert.equal(R.activateAppCommand(p, 4242), null);
    assert.equal(R.replaceAvailable(p), false, p + ': the button is not offered');
  }
  assert.equal(R.replaceAvailable('darwin'), true);
  assert.equal(R.replaceLabel(SAFARI), 'Replace in Safari');
  assert.equal(R.replaceLabel(null), 'Replace');
});

test('the page: the button only under a finished answer to the selection', () => {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const row = {id: 7, k: 'assistant', text: 'Better words.', replace: true};
  assert.equal(S.mcReplaceOffered(row, 'Replace in Safari', false), true);
  assert.equal(S.mcReplaceOffered(row, 'Replace in Safari', true), false, 'still streaming');
  assert.equal(S.mcReplaceOffered(row, null, false), false, 'off macOS or no app known');
  assert.equal(S.mcReplaceOffered(Object.assign({}, row, {replace: false}), 'Replace in Safari', false), false, 'a message without the selection');
  for (const text of ['', '(no reply)', '(stopped)']) assert.equal(S.mcReplaceOffered(Object.assign({}, row, {text}), 'R', false), false, text);
  assert.equal(S.mcReplaceOffered({id: 1, k: 'user', text: 'x', replace: true}, 'R', false), false);
  const html = S.mcReplaceHTML(row, 'Replace in <Ev"il>', false, esc);
  assert.match(html, /<button type="button" class="mc-act mc-replace" data-replace="7">Replace in &lt;Ev&quot;il>/);
  assert.equal(S.mcReplaceHTML(row, null, false, esc), '');
});

test('the wiring: main keeps the app, the page marks the answer and asks main', () => {
  const qw = src('../main/quick-entry-window.ts');
  assert.match(qw, /source = sel \? sel\.app : null;/);
  assert.match(qw, /replace: source \? replaceLabel\(source\) : null, selection, notice \}/);
  assert.match(qw, /ipcMain\.handle\("app:quickEntryReplace"/);
  assert.match(qw, /event\.sender !== box\.webContents/, 'only the mini chat that has the selection');
  assert.match(qw, /replaceInSourceApp\(\{[\s\S]*?paste: pasteIntoFrontApp,[\s\S]*?\}, source, raw\)/);
  // ATO-2736: the read itself moved to selected-text-grab.ts; the Electron half passes the reads in.
  const ipc = src('../main/selected-text-ipc.ts');
  assert.match(ipc, /withFrontApp: replaceAvailable\(w\.platform\),[\s\S]*?readText: readSelectedText,[\s\S]*?readFrontApp,/);
  const grab = src('../main/selected-text-grab.ts');
  assert.match(grab, /Promise\.all\(\[d\.readText\(\), front\]\)/);
  assert.match(grab, /d\.withFrontApp \? d\.readFrontApp\(\)/);
  assert.match(src('../preload/preload.ts'), /quickEntryReplace: \(text: string\) => ipcRenderer\.invoke\("app:quickEntryReplace", text\)/);
  const js = src('../renderer/mini-chat.js');
  assert.match(js, /if \(withSelection && st\.reply\) st\.reply\.replace = true;/);
  assert.match(js, /st\.replaceLabel = typeof opened\.replace === 'string'/);
  assert.match(js, /mcReplaceHTML\(r, st\.replaceLabel, st\.reply === r, mcEsc\)/);
  assert.match(js, /BR\.quickEntryReplace\(row\.text\)/);
});

/* ---------- ATO-2750: a failed Replace comes back to the mini chat ---------- */

test('ATO-2750: a failure brings the mini chat back with the line and Copy answer; no notification', async () => {
  const cases = [
    {name: 'not back', set: (d, log) => { d.activate = async () => { log.push('activate'); return false; }; }, line: /Could not switch back to Safari/},
    {name: 'no keystroke', set: (d) => { d.paste = async () => ({pasted: false, reason: 'no-keystroke'}); }, line: /press ⌘V in Safari/},
    {name: 'failed', set: (d) => { d.paste = async () => ({pasted: false, reason: 'failed'}); }, line: /could not be pasted into Safari\. Copy it and paste it by hand\./},
    {name: 'threw', set: (d) => { d.paste = async () => { throw new Error('x'); }; }, line: /could not be pasted into Safari/},
  ];
  for (const c of cases) {
    const {deps, log} = fakes();
    deps.bringBack = () => { log.push('back'); return true; };
    c.set(deps, log);
    const out = await R.replaceInSourceApp(deps, SAFARI, 'Answer');
    assert.equal(out.ok, false, c.name);
    assert.equal(out.hidden, false, c.name + ': the page shows it');
    assert.equal(out.copy, true, c.name + ': with Copy answer');
    assert.match(out.error, c.line, c.name);
    assert.deepEqual(deps.lines, [], c.name + ': no notification');
    assert.ok(log.includes('back') && !log.includes('close'), c.name + ': brought back, not closed');
  }
});

test('ATO-2750: the window cannot come back: the notification as before, the main-window line for a failed paste', async () => {
  const {deps, log} = fakes();
  deps.bringBack = () => { log.push('back'); throw new Error('destroyed'); };
  deps.paste = async () => ({pasted: false, reason: 'failed'});
  const out = await R.replaceInSourceApp(deps, SAFARI, 'Answer');
  assert.deepEqual(out, {ok: false, hidden: true, error: 'The answer could not be pasted. It is kept in the chat in the main window.'});
  assert.deepEqual(deps.lines, [out.error]);
});

test('ATO-2750: the wiring: hidden, not destroyed, during the paste; Copy answer through main; the page draws the line', () => {
  const qw = src('../main/quick-entry-window.ts');
  assert.match(qw, /hide: \(\) => \{ if \(box && !box\.isDestroyed\(\)\) box\.hide\(\); \},/);
  assert.match(qw, /bringBack: \(\) => \{[\s\S]*?box\.show\(\);[\s\S]*?return true;/);
  assert.match(qw, /close: hide,/);
  assert.match(qw, /ipcMain\.handle\("app:quickEntryCopy"[\s\S]*?event\.sender !== box\.webContents[\s\S]*?clipboard\.writeText\(text\)/);
  assert.match(src('../preload/preload.ts'), /quickEntryCopy: \(text: string\) => ipcRenderer\.invoke\("app:quickEntryCopy", text\)/);
  assert.match(src('../renderer/mini-chat.js'), /if \(res && res\.copy && typeof mcReplaceFailed === 'function'\) \{ put\.disabled = false; mcReplaceFailed\(res\.error, row\.text, BR\); return; \}/);
  const N = require('../renderer/mini-chat-notice.js');
  assert.deepEqual(N.mcReplaceFailedView('Could not switch back to Safari.'), {text: 'Could not switch back to Safari.', tone: 'bad', button: 'Copy answer', act: 'copy'});
  assert.equal(N.mcReplaceFailedView('').text, 'The text could not be replaced.');
});

test('ATO-2750: one name for the window: Mini Chat, and Open in main window', () => {
  const html = src('../renderer/mini-chat.html');
  assert.match(html, /<title>Mini Chat<\/title>/);
  assert.match(html, /id="mc-open"[^>]*>Open in main window</);
  assert.doesNotMatch(html, /big window/);
  assert.match(src('../main/quick-entry-window.ts'), /title: "Mini Chat",/);
  assert.doesNotMatch(src('../renderer/mini-chat.js'), /Open the big window/);
});
