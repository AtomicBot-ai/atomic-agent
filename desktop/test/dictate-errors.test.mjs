// ATO-2750: Dictate anywhere shows a failure in its pill, not only in a
// system notification. The lines and the panes (main/dictate-errors.ts,
// against the built output), the pill's failure mode
// (renderer/dictate-anywhere-failure.js), the Settings row's Open Privacy
// Settings in the shortcut mode, and the wiring (read from the sources).
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../out/main/dictate-errors.js');
const F = require('../renderer/dictate-anywhere-failure.js');
const {dictateAnywhereRowHTML} = require('../renderer/dictate-anywhere-settings.js');
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const KINDS = [{kind: 'unavailable', reason: 'Voice input is not available on this computer.'}, {kind: 'mic-off'}, {kind: 'start-failed'},
  {kind: 'mic-failed'}, {kind: 'take-failed'}, {kind: 'paste', accessibility: true}, {kind: 'paste', accessibility: false}];

test('every failure is a plain line, with no raw error and no long dash', () => {
  for (const p of ['darwin', 'win32', 'linux']) {
    for (const f of KINDS) {
      const v = E.dictateFailureView(f, p);
      assert.ok(v.line.length > 10, p + ' ' + f.kind);
      assert.doesNotMatch(v.line, /—|undefined|null|Error:|\(\)/, p + ' ' + f.kind);
    }
  }
  assert.equal(E.dictateFailureView(KINDS[0], 'darwin').line, KINDS[0].reason, 'the unavailable reason is already worded');
});

test('the microphone failures open the microphone pane on macOS and Windows; Linux has no button', () => {
  for (const f of [{kind: 'mic-off'}, {kind: 'start-failed'}, {kind: 'mic-failed'}]) {
    assert.deepEqual(E.dictateFailureView(f, 'darwin').fix, 'microphone');
    assert.equal(E.dictateFailureView(f, 'darwin').fixLabel, 'Open Privacy Settings');
    assert.equal(E.dictateFailureView(f, 'win32').fix, 'microphone');
    assert.equal(E.dictateFailureView(f, 'linux').fix, null);
    assert.equal(E.dictateFailureView(f, 'linux').fixLabel, null);
  }
  assert.match(E.dictateFixUrl('microphone', 'darwin'), /Privacy_Microphone$/);
  assert.equal(E.dictateFixUrl('microphone', 'win32'), 'ms-settings:privacy-microphone');
  assert.equal(E.dictateFixUrl('microphone', 'linux'), null);
  assert.match(E.dictateFixUrl('accessibility', 'darwin'), /Privacy_Accessibility$/);
  assert.equal(E.dictateFixUrl('accessibility', 'win32'), null);
});

test('a paste that did not go: the clipboard line with the right shortcut; Accessibility only on a Mac', () => {
  const mac = E.dictateFailureView({kind: 'paste', accessibility: true}, 'darwin');
  assert.match(mac.line, /press ⌘V/);
  assert.equal(mac.fix, 'accessibility');
  assert.match(E.dictateFailureView({kind: 'paste', accessibility: false}, 'darwin').line, /press ⌘V where you want it/);
  assert.equal(E.dictateFailureView({kind: 'paste', accessibility: false}, 'darwin').fix, null);
  const win = E.dictateFailureView({kind: 'paste', accessibility: true}, 'win32');
  assert.match(win.line, /press Ctrl\+V where you want it/);
  assert.equal(win.fix, null);
  assert.equal(E.dictateFailureView({kind: 'take-failed'}, 'darwin').fix, null);
});

test('the pill draws main\'s failure, and nothing for a normal take', () => {
  assert.equal(F.daFailureView(null), null);
  assert.equal(F.daFailureView({line: ''}), null);
  assert.deepEqual(F.daFailureView({line: 'Microphone access is turned off for Atomic Agent.', fixLabel: 'Open Privacy Settings'}),
    {line: 'Microphone access is turned off for Atomic Agent.', button: 'Open Privacy Settings'});
  assert.deepEqual(F.daFailureView({line: 'x', fixLabel: null}), {line: 'x', button: null});
});

test('the wiring: failures go to the pill, the notification only when it cannot show, no raw res.error', () => {
  const win = src('../main/dictate-anywhere-window.ts');
  const pillSrc = src('../main/dictate-pill.ts');
  const pageIpc = src('../main/dictate-pill-ipc.ts');
  assert.doesNotMatch(win, /Notification|notify\(/, 'the take never notifies itself');
  assert.match(pillSrc, /if \(!this\.show\(true\)\) \{ this\.failure = null; notifyDictation\(view\.line\); return; \}/);
  assert.equal((pillSrc.match(/notifyDictation\(/g) || []).length, 1, 'one notification left: the fallback');
  assert.match(pillSrc, /if \(!forFailure && !globalShortcut\.isRegistered\("Escape"\)\)/, 'a failure pill does not take Esc');
  assert.match(win, /fail\(\{ kind: "start-failed" \}, res\.error\)/, 'the raw error goes to the log line');
  assert.match(win, /fail\(\{ kind: "mic-off" \}\)/);
  assert.match(win, /fail\(\{ kind: "paste", accessibility:/);
  assert.match(win, /pill\.showFailure\(view\)/);
  assert.match(win, /wireDictatePillPage\(pill, \{/);
  assert.match(pageIpc, /ipcMain\.handle\("app:dictateFix"/);
  assert.match(pageIpc, /failure: failed \}/, 'the pill page is told');
  assert.match(win, /if \(pill\.failure\) closePill\(\);\s*\/\/ ATO-2750: a new take/);
  const pre = src('../preload/preload.ts');
  assert.match(pre, /dictateFix: \(\) => ipcRenderer\.invoke\("app:dictateFix"\)/);
  assert.match(pre, /dictateMicFailed: \(why: \{ denied: boolean; detail\?: string \}\)/);
  const page = src('../renderer/dictate-anywhere.js');
  assert.match(page, /if \(opened && opened\.failure && typeof daShowFailure === 'function'\) \{ daShowFailure\(opened\.failure, BR\); return; \}/);
  assert.ok(page.indexOf('daShowFailure(') < page.indexOf('getUserMedia'), 'a failure pill never opens the microphone');
  assert.doesNotMatch(page, /'The microphone could not be opened' \+/, 'the browser message is not shown');
  const html = src('../renderer/dictate-anywhere.html');
  assert.ok(html.indexOf('dictate-anywhere-failure.js') > 0 && html.indexOf('dictate-anywhere-failure.js') < html.indexOf('src="dictate-anywhere.js"'));
});

test('the danger token, not a hardcoded red', () => {
  const css = src('../renderer/css/dictate-anywhere.css');
  assert.doesNotMatch(css, /#E5484D/i);
  assert.match(css, /\.da-dot \{[^}]*background: var\(--danger/);
  assert.match(src('../renderer/styles.css'), /--danger:var\(--critical\)/);
});

test('the shortcut mode offers Open Privacy Settings when the paste needs Accessibility', () => {
  const h = {esc: (s) => String(s), setSwitchHTML: (o) => '<button data-act="' + o.act + '"></button>'};
  const info = {ok: true, enabled: true, mode: 'toggle', accelerator: 'Control+Alt+D', label: '⌃⌥D', holdLabel: 'Fn', holdNote: null, holdState: 'off', holdError: null,
    canOpenPrivacy: true, state: 'registered', error: null, available: true, reason: null, hint: 'Typing into other apps needs Accessibility'};
  assert.match(dictateAnywhereRowHTML({info, busy: false, recording: false, error: null}, h), /data-act="dictate:privacy"[^>]*>Open Privacy Settings/);
  assert.doesNotMatch(dictateAnywhereRowHTML({info: Object.assign({}, info, {canOpenPrivacy: false}), busy: false, recording: false, error: null}, h), /dictate:privacy/);
  const win = src('../main/dictate-anywhere-window.ts');
  assert.match(win, /canOpenPrivacy: !!dictatePrivacyUrl\(w\.platform\) && \(\(holdOn && watcher\.state === "untrusted"\) \|\| \(pref\.enabled && !keystrokesAllowed\(false\)\)\)/);
});
