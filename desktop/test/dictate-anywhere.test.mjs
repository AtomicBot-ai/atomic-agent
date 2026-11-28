// ATO-1064: dictation into any app. The pure half (main/dictate-anywhere.ts
// and main/dictate-hold.ts, against the built output) and the Settings row
// (renderer/dictate-anywhere-settings.js).
// Run: npm run build && npm run test:unit
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../out/main/dictate-anywhere.js');
const H = require('../out/main/dictate-hold.js');
const Q = require('../out/main/quick-entry.js');
const {dictateAnywhereRowHTML} = require('../renderer/dictate-anywhere-settings.js');

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, {recursive: true, force: true}); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'da-')); dirs.push(d); return d; };
const h = {esc: (s) => String(s).replace(/</g, '&lt;'), setSwitchHTML: (o) => '<button data-act="' + o.act + '" data-on="' + !!o.on + '"' + (o.disabled ? ' disabled' : '') + '></button>'};

test('off by default; hold Fn on a Mac, hold Ctrl+Win on Windows, a combo on Linux', () => {
  assert.deepEqual(D.dictateDefaultPref('darwin'), {enabled: false, mode: 'hold', accelerator: 'Control+Alt+D'});
  assert.deepEqual(D.dictateDefaultPref('win32'), {enabled: false, mode: 'hold', accelerator: 'Control+Alt+D'});
  assert.deepEqual(D.dictateDefaultPref('linux'), {enabled: false, mode: 'toggle', accelerator: 'Control+Alt+D'});
  assert.equal(H.holdKeyFor('darwin'), 'fn');
  assert.equal(H.holdKeyFor('win32'), 'ctrl+win');
  assert.equal(H.holdKeyFor('linux'), null);
  assert.equal(H.holdKeyLabel('darwin'), 'Fn');
  assert.equal(H.holdKeyLabel('win32'), 'Ctrl+Win');
  assert.deepEqual(Q.normalizeAccelerator(D.DICTATE_TOGGLE_ACCELERATOR), {ok: true, accelerator: 'Control+Alt+D'});
  assert.notEqual(D.DICTATE_TOGGLE_ACCELERATOR, Q.QUICK_ENTRY_DEFAULT_ACCELERATOR);
});

test('the saved pref: missing, broken and good files, the mode per platform', () => {
  const mac = D.dictateDefaultPref('darwin');
  assert.deepEqual(D.parseDictatePref(null, 'darwin'), mac);
  assert.deepEqual(D.parseDictatePref('{', 'darwin'), mac);
  assert.deepEqual(D.parseDictatePref('{"enabled":true,"accelerator":"Space"}', 'darwin'), {enabled: true, mode: 'hold', accelerator: 'Control+Alt+D'});
  assert.deepEqual(D.parseDictatePref('{"enabled":true,"mode":"toggle","accelerator":"alt+cmd+j"}', 'darwin'), {enabled: true, mode: 'toggle', accelerator: 'Command+Alt+J'});
  assert.deepEqual(D.parseDictatePref('{"enabled":true,"mode":"hold"}', 'linux'), {enabled: true, mode: 'toggle', accelerator: 'Control+Alt+D'}, 'no hold key on Linux');
  assert.equal(D.parseDictatePref('{"mode":"sideways"}', 'win32').mode, 'hold');
  const d = tmp();
  assert.deepEqual(D.readDictatePref(d, 'darwin'), mac);
  assert.equal(D.writeDictatePref(d, {enabled: true, mode: 'toggle', accelerator: 'Control+Alt+K'}), true);
  assert.deepEqual(D.readDictatePref(d, 'darwin'), {enabled: true, mode: 'toggle', accelerator: 'Control+Alt+K'});
  assert.deepEqual(JSON.parse(readFileSync(D.dictatePrefPath(d), 'utf8')), {enabled: true, mode: 'toggle', accelerator: 'Control+Alt+K'});
  writeFileSync(D.dictatePrefPath(d), 'null');
  assert.deepEqual(D.readDictatePref(d, 'darwin'), mac);
  assert.match(D.dictatePrefPath(d), /dictate-anywhere\.json$/);
});

test('a Settings write: a recorded combo means toggle, hold comes back, hold is refused on Linux', () => {
  const mac = D.dictateDefaultPref('darwin');
  assert.deepEqual(D.mergeDictatePref(mac, {enabled: true}, 'darwin'), {ok: true, pref: {enabled: true, mode: 'hold', accelerator: 'Control+Alt+D'}});
  const rec = D.mergeDictatePref(mac, {enabled: true, accelerator: 'cmd+alt+j'}, 'darwin');
  assert.deepEqual(rec, {ok: true, pref: {enabled: true, mode: 'toggle', accelerator: 'Command+Alt+J'}});
  assert.deepEqual(D.mergeDictatePref(rec.pref, {mode: 'hold'}, 'darwin'), {ok: true, pref: {enabled: true, mode: 'hold', accelerator: 'Command+Alt+J'}}, 'the combo is kept for later');
  assert.equal(D.mergeDictatePref(mac, {mode: 'hold'}, 'linux').ok, false);
  assert.equal(D.mergeDictatePref(mac, {mode: 'press'}, 'darwin').ok, false);
  assert.equal(D.mergeDictatePref(mac, {accelerator: 'Space'}, 'darwin').ok, false);
  assert.equal(D.mergeDictatePref(mac, {enabled: 'yes'}, 'darwin').ok, false);
  assert.equal(D.mergeDictatePref(mac, null, 'darwin').ok, false);
});

/* A fake clock for the hold machine. */
function clock() {
  let now = 0;
  let seq = 0;
  const due = new Map();
  return {
    timers: {
      set: (ms, fn) => { const id = ++seq; due.set(id, {at: now + ms, fn}); return id; },
      clear: (id) => { due.delete(id); },
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...due]) if (t.at <= now) { due.delete(id); t.fn(); }
    },
    pending: () => due.size,
  };
}

test('hold to talk: a tap does nothing, a hold starts, letting go finishes', () => {
  const c = clock();
  const acts = [];
  const m = new H.HoldMachine(c.timers, (a) => acts.push(a));
  m.down(); c.advance(H.HOLD_START_DELAY_MS - 1); m.up();
  c.advance(1000);
  assert.deepEqual(acts, [], 'a tap shorter than the delay never starts a take');
  assert.equal(c.pending(), 0);

  m.down(); c.advance(H.HOLD_START_DELAY_MS);
  assert.deepEqual(acts, ['start']);
  assert.equal(m.state, 'held');
  m.down();   // key repeat
  m.up();
  assert.deepEqual(acts, ['start', 'finish']);
  assert.equal(m.state, 'idle');
  m.up();
  assert.deepEqual(acts, ['start', 'finish'], 'a stray up is nothing');
});

test('hold to talk: Esc or a chord cancels, and the rest of that hold is ignored', () => {
  const c = clock();
  const acts = [];
  const m = new H.HoldMachine(c.timers, (a) => acts.push(a));
  m.down(); c.advance(300); m.esc();
  assert.deepEqual(acts, ['start', 'cancel']);
  m.down(); c.advance(1000); m.up();
  assert.deepEqual(acts, ['start', 'cancel'], 'still the same hold: nothing starts, nothing is typed');
  assert.equal(m.state, 'idle');

  m.down(); c.advance(50); m.other(); c.advance(1000); m.up();
  assert.deepEqual(acts, ['start', 'cancel'], 'Fn+arrow before the delay: no take at all');

  m.down(); c.advance(300); m.reset();
  assert.deepEqual(acts, ['start', 'cancel', 'start', 'cancel'], 'the watcher died while held: the take goes');
  m.down(); m.reset(); c.advance(1000);
  assert.deepEqual(acts, ['start', 'cancel', 'start', 'cancel'], 'reset before the delay: nothing');
});

test("the watcher's lines", () => {
  for (const w of ['ready', 'down', 'up', 'esc', 'other', 'untrusted']) assert.deepEqual(H.parseHoldKeyLine(w + '\r'), {type: w});
  assert.deepEqual(H.parseHoldKeyLine('\uFEFFready'), {type: 'ready'});
  assert.deepEqual(H.parseHoldKeyLine('error SetWindowsHookEx failed (5)'), {type: 'error', message: 'SetWindowsHookEx failed (5)'});
  assert.equal(H.parseHoldKeyLine('error').type, 'error');
  assert.equal(H.parseHoldKeyLine(''), null);
  assert.equal(H.parseHoldKeyLine('WARNING: something'), null);
  assert.equal(H.parseHoldKeyLine('downtown'), null);
  const b = new H.LineBuffer();
  assert.deepEqual(b.push('rea'), []);
  assert.deepEqual(b.push('dy\r\ndown\nu'), ['ready', 'down']);
  assert.deepEqual(b.push('p\n'), ['up']);
});

test('the watcher command: the Mac helper; no process at all on Windows or Linux', () => {
  assert.deepEqual(H.holdKeyCommand('darwin', '/App/Contents/Resources/native'), {file: '/App/Contents/Resources/native/atomic-fn-key', args: []});
  assert.equal(H.holdKeyCommand('linux', '/x'), null);
  assert.equal(H.holdKeyCommand('win32', 'C:\\x'), null, 'Windows starts no PowerShell (ATO-1064 review)');
  assert.equal(H.WINDOWS_HOLD_KEY_SCRIPT, undefined, 'the PowerShell hook is gone');
  for (const f of ['main/dictate-hold.ts', 'main/hold-key-uiohook.ts', 'main/dictate-anywhere-window.ts', 'main/dictate-hold-watch.ts']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /powershell\.exe|-EncodedCommand|ExecutionPolicy/i, f + ': no PowerShell');
  }
  // ATO-2750: the watcher's wiring moved to dictate-hold-watch.ts.
  const wiring = readFileSync(new URL('../main/dictate-hold-watch.ts', import.meta.url), 'utf8');
  assert.match(wiring, /platform === "win32"\s*\?\s*new UiohookHoldWatcher\(/, 'Windows uses the in-process watcher');
  assert.match(readFileSync(new URL('../main/dictate-anywhere-window.ts', import.meta.url), 'utf8'), /holdKeyWatch\(w\.platform, w\.log, onHold,/);
});

/** A fake uIOhook: `emit` plays a key, `fail` makes start() throw. */
function fakeHook({fail = false} = {}) {
  const fns = {keydown: [], keyup: []};
  const hook = {
    started: 0, stopped: 0,
    on: (ev, fn) => { fns[ev].push(fn); },
    removeListener: (ev, fn) => { fns[ev] = fns[ev].filter((f) => f !== fn); },
    start: () => { if (fail) throw new Error('hook failed'); hook.started++; },
    stop: () => { hook.stopped++; },
    emit: (ev, keycode) => { for (const f of fns[ev]) f({keycode}); },
    listeners: () => fns.keydown.length + fns.keyup.length,
  };
  return hook;
}

test('Windows: uiohook key events turn into the same down/up/esc/other lines', () => {
  const K = H.UIOHOOK_KEYS;
  assert.deepEqual({...K}, {escape: 1, ctrl: 29, ctrlRight: 3613, meta: 3675, metaRight: 3676}, "uiohook-napi's UiohookKey codes");
  const c = new H.WinHoldChord();
  const t = (kind, code) => { const l = c.key(kind, code); return l ? l.type : null; };
  assert.equal(t('down', K.ctrl), null, 'Ctrl alone is nothing');
  assert.equal(t('down', 30), null, 'a key with only Ctrl held is not reported');
  assert.equal(t('up', 30), null);
  assert.equal(t('down', K.meta), 'down', 'Ctrl+Win');
  assert.equal(t('down', K.meta), null, 'key repeat');
  assert.equal(t('down', K.ctrl), null, 'key repeat');
  assert.equal(t('down', K.escape), 'esc');
  assert.equal(t('down', 32), 'other', 'Ctrl+Win+D is a chord');
  assert.equal(t('up', 32), null, 'a key going up says nothing');
  assert.equal(t('up', K.meta), 'up');
  assert.equal(t('up', K.ctrl), null);
  assert.equal(t('down', K.metaRight), null, 'Win alone is nothing');
  assert.equal(t('down', K.ctrlRight), 'down', 'right-hand keys, either order');
  assert.equal(t('up', K.ctrlRight), 'up');
  c.clear();
  assert.equal(t('down', K.ctrl), null, 'cleared: the held Win is forgotten');
});

test('Windows: the in-process watcher feeds the hold machine; it starts nothing until asked', () => {
  const U = require('../out/main/hold-key-uiohook.js');
  const clockNow = clock();
  const acts = [];
  const m = new H.HoldMachine(clockNow.timers, (a) => acts.push(a));
  const states = [];
  const hook = fakeHook();
  let loads = 0;
  const w = new U.UiohookHoldWatcher((line) => {
    if (line.type === 'down') m.down(); else if (line.type === 'up') m.up(); else if (line.type === 'esc') m.esc(); else if (line.type === 'other') m.other();
  }, (st) => states.push(st), () => {}, () => { loads++; return hook; });
  assert.equal(loads, 0, 'the module is not loaded before the hold mode starts the watcher');
  assert.equal(w.state, 'off');
  w.start();
  assert.equal(loads, 1);
  assert.equal(hook.started, 1);
  assert.equal(w.state, 'ready');
  assert.deepEqual(states, ['starting', 'ready']);
  w.start();
  assert.equal(hook.started, 1, 'a second start is nothing');

  const K = H.UIOHOOK_KEYS;
  hook.emit('keydown', K.ctrl); hook.emit('keydown', K.meta); clockNow.advance(300);
  hook.emit('keyup', K.meta);
  assert.deepEqual(acts, ['start', 'finish'], 'hold Ctrl+Win past the delay, let go: a take');
  hook.emit('keyup', K.ctrl);
  hook.emit('keydown', K.ctrl); hook.emit('keydown', K.meta); clockNow.advance(50); hook.emit('keyup', K.meta);
  assert.deepEqual(acts, ['start', 'finish'], 'a tap: nothing');
  hook.emit('keyup', K.ctrl);
  hook.emit('keydown', K.ctrl); hook.emit('keydown', K.meta); clockNow.advance(300); hook.emit('keydown', K.escape);
  assert.deepEqual(acts, ['start', 'finish', 'start', 'cancel'], 'Esc throws the take away');
  hook.emit('keyup', K.meta); hook.emit('keyup', K.ctrl);

  w.stop();
  assert.equal(hook.stopped, 1);
  assert.equal(hook.listeners(), 0, 'its listeners are removed');
  assert.equal(w.state, 'off');
  hook.emit('keydown', K.ctrl); hook.emit('keydown', K.meta); clockNow.advance(300);
  assert.deepEqual(acts, ['start', 'finish', 'start', 'cancel'], 'stopped: keys do nothing');
});

test('Windows: a module that cannot load or start leaves the toggle combo in charge', () => {
  const U = require('../out/main/hold-key-uiohook.js');
  const logs = [];
  const w = new U.UiohookHoldWatcher(() => assert.fail('no key'), () => {}, (l) => logs.push(l), () => { throw new Error("Cannot find module 'uiohook-napi'"); });
  w.start();
  assert.equal(w.state, 'failed');
  assert.equal(H.holdWatchFailed(w.state), true, 'the combo stands in');
  assert.equal(w.detail, 'could not load the key watcher');
  assert.match(logs.join('\n'), /Cannot find module/);
  assert.match(H.holdWatchLine(w.state, 'win32', 'Ctrl+Alt+D', w.detail), /Ctrl\+Win key watcher stopped \(could not load the key watcher\)\. Until then Ctrl\+Alt\+D starts and ends a take/);

  const bad = fakeHook({fail: true});
  const w2 = new U.UiohookHoldWatcher(() => {}, () => {}, () => {}, () => bad);
  w2.start();
  assert.equal(w2.state, 'failed');
  assert.equal(w2.detail, 'could not start the key watcher');
  assert.equal(bad.listeners(), 0, 'no listener left behind');
  w2.stop();
  assert.equal(w2.state, 'off');
});

test('when the hold key cannot be watched, Settings says why and what works meanwhile', () => {
  assert.equal(H.holdWatchFailed('ready'), false);
  assert.equal(H.holdWatchFailed('starting'), false);
  assert.equal(H.holdWatchFailed('untrusted'), true);
  assert.equal(H.holdWatchFailed('missing'), true);
  assert.equal(H.holdWatchFailed('failed'), true);
  assert.match(H.holdWatchLine('untrusted', 'darwin', '⌃⌥D'), /Holding Fn needs Accessibility.*Until then ⌃⌥D starts and ends a take/);
  assert.match(H.holdWatchLine('failed', 'win32', 'Ctrl+Alt+D', 'exit code 4'), /Ctrl\+Win key watcher stopped \(exit code 4\)/);
  assert.match(H.holdWatchLine('missing', 'darwin', ''), /no Fn key watcher\.$/);
  assert.equal(H.holdWatchLine('ready', 'darwin', '⌃⌥D'), null);
  assert.match(H.holdKeyNote('darwin'), /Do Nothing/);
  assert.equal(H.holdKeyNote('win32'), null);
  assert.match(H.dictatePrivacyUrl('darwin'), /Privacy_Accessibility/);
  assert.equal(H.dictatePrivacyUrl('win32'), null);
});

test("the quick entry box's combo is refused, whatever its spelling", () => {
  assert.match(D.dictateClash({accelerator: 'shift+cmdorctrl+space'}, 'CommandOrControl+Shift+Space'), /quick entry box uses/);
  assert.equal(D.dictateClash({accelerator: 'Control+Alt+D'}, 'CommandOrControl+Shift+Space'), null);
  assert.equal(D.dictateClash({enabled: true}, 'CommandOrControl+Shift+Space'), null);
  assert.equal(D.dictateClash({accelerator: 'Control+Alt+D'}, null), null);
});

test('ATO-979: no backend, no switch, with the reason', () => {
  const no = (reason, extra = {}) => D.dictateUnavailableReason({ok: false, reason, installed: [], ...extra});
  assert.match(no('voice-helper-missing'), /no speech helper/);
  assert.match(no('voice-os-too-old'), /macOS 26/);
  assert.match(no('voice-whisper-missing', {canDownload: true}), /press the microphone in the composer/);
  assert.match(no('voice-whisper-model-missing'), /press the microphone in the composer/);
  assert.match(no('something-new'), /not available/);
  assert.match(D.dictateUnavailableReason({ok: true, installed: []}), /Download a dictation language/);
  assert.equal(D.dictateUnavailableReason({ok: true, installed: ['en-US']}), null);
});

test("a take's languages: the composer's, else the app's, else English, else the first", () => {
  assert.deepEqual(D.pickDictateLocales(['ru-RU', 'en-US', 'de-DE'], ['en-US', 'ru-RU', 'de-DE'], 'en-US'), ['ru-RU', 'en-US']);
  assert.deepEqual(D.pickDictateLocales(['fr-FR'], ['en-US', 'ru-RU'], 'ru'), ['ru-RU'], 'a chosen one not downloaded is skipped');
  assert.deepEqual(D.pickDictateLocales([], ['de-DE', 'en-GB'], 'pt_BR'), ['en-GB']);
  assert.deepEqual(D.pickDictateLocales([], ['de-DE'], 'ja'), ['de-DE']);
  assert.deepEqual(D.pickDictateLocales([], [], 'en'), []);
});

test("a take's text: finals add up, a final clears its partial, replace wins", () => {
  const t = new D.DictateTake();
  assert.equal(t.apply({type: 'ready', locales: ['en-US']}), 'continue');
  t.apply({type: 'partial', text: 'Hello'});
  assert.equal(t.live(), 'Hello');
  t.apply({type: 'final', text: 'Hello there. '});
  t.apply({type: 'partial', text: 'How are'});
  assert.equal(t.live(), 'Hello there. How are');
  t.apply({type: 'final', text: 'How are you?'});
  assert.equal(t.text(), 'Hello there. How are you?', 'no sentence twice');
  t.apply({type: 'replace', text: 'Привет', locale: 'ru-RU'});
  assert.equal(t.text(), 'Привет');
  t.stop();
  assert.equal(t.apply({type: 'done'}), 'done');
});

test('a take ends: done, closed after stop, cancelled, or failed before stop', () => {
  const stopped = new D.DictateTake();
  stopped.apply({type: 'partial', text: 'never closed'});
  stopped.stop();
  assert.equal(stopped.apply({type: 'closed', code: 0}), 'done');
  assert.equal(stopped.text(), 'never closed', 'a last partial is typed too');

  assert.equal(new D.DictateTake().apply({type: 'closed', cancelled: true}), 'cancelled');

  const early = new D.DictateTake();
  assert.equal(early.apply({type: 'closed', code: 1}), 'failed');
  assert.match(early.error, /stopped unexpectedly/);

  const err = new D.DictateTake();
  assert.equal(err.apply({type: 'error', code: 'too-long', message: 'voice input stops after five minutes'}), 'failed');
  const late = new D.DictateTake();
  late.stop();
  assert.equal(late.apply({type: 'error', code: 'whisper', message: 'whisper.cpp failed: x'}), 'continue', 'whisper sends done after its error');
  assert.equal(late.apply({type: 'done'}), 'done');
  assert.match(late.error, /whisper/);
  assert.equal(new D.DictateTake().apply({type: 'error', code: 'install'}), 'continue');
  assert.equal(new D.DictateTake().apply(null), 'continue');
});

test('the end of a take may take longer on the whisper.cpp route', () => {
  assert.ok(D.dictateFinishTimeoutMs('win32') > D.dictateFinishTimeoutMs('darwin'));
  assert.ok(D.dictateFinishTimeoutMs('linux') >= 180_000, 'past speech.ts WHISPER_TIMEOUT_MS');
});

test('the pill: centred near the bottom of the display under the cursor', () => {
  const displays = [
    {bounds: {x: 0, y: 0, width: 1440, height: 900}, workArea: {x: 0, y: 25, width: 1440, height: 800}},
    {bounds: {x: 1440, y: 0, width: 1920, height: 1080}, workArea: {x: 1440, y: 0, width: 1920, height: 1040}},
  ];
  const b = D.dictatePillBounds({x: 2000, y: 500}, displays);
  assert.equal(b.width, D.DICTATE_PILL_SIZE.width);
  assert.equal(b.x, 1440 + Math.round((1920 - b.width) / 2));
  assert.equal(b.y, 1040 - D.DICTATE_PILL_SIZE.height - 48);
  const small = D.dictatePillBounds({x: 10, y: 10}, [{bounds: {x: 0, y: 0, width: 300, height: 200}, workArea: {x: 0, y: 0, width: 300, height: 200}}]);
  assert.ok(small.x >= 0 && small.x + small.width <= 300);
});

test('the Settings row: switch, combo, the reason when it cannot run', () => {
  const info = {ok: true, enabled: true, mode: 'toggle', accelerator: 'Control+Alt+D', label: '⌃⌥D', holdLabel: 'Fn', holdNote: null, holdState: 'off', holdError: null, canOpenPrivacy: false, state: 'registered', error: null, available: true, reason: null, hint: null};
  const html = dictateAnywhereRowHTML({info, busy: false, recording: false, error: null}, h);
  assert.match(html, /Dictate into any app/);
  assert.match(html, /data-act="dictate:record"[^>]*>⌃⌥D · Change…/);
  assert.match(html, /data-act="dictate:hold"[^>]*>Hold Fn instead/);
  assert.match(html, /data-act="dictate:toggle" data-on="true"/);
  assert.doesNotMatch(html, /tk-help--warn/);

  const linux = dictateAnywhereRowHTML({info: Object.assign({}, info, {holdLabel: null}), busy: false, recording: false, error: null}, h);
  assert.doesNotMatch(linux, /dictate:hold/, 'no hold key on Linux');

  const none = dictateAnywhereRowHTML({info: Object.assign({}, info, {enabled: false, available: false, reason: 'This build has no speech helper, so dictation cannot run.'}), busy: false, recording: false, error: null}, h);
  assert.match(none, /tk-help--warn[^>]*>This build has no speech helper/);
  assert.match(none, /data-act="dictate:toggle"[^>]* disabled/);
  assert.match(none, /data-act="dictate:record"[^>]* disabled/);

  const hint = dictateAnywhereRowHTML({info: Object.assign({}, info, {hint: 'Typing into other apps needs Accessibility'}), busy: false, recording: false, error: null}, h);
  assert.match(hint, /needs Accessibility/);

  const rec = dictateAnywhereRowHTML({info, busy: false, recording: true, error: null}, h);
  assert.match(rec, /data-act="dictate:cancel"/);
  assert.match(rec, /Press the new combination now/);
  assert.match(dictateAnywhereRowHTML({info: null, busy: false, recording: false, error: null}, h), /data-act="dictate:toggle"[^>]* disabled/);
});

test('the Settings row in the hold mode: hold Fn, the emoji note, Open Privacy Settings when untrusted', () => {
  const info = {ok: true, enabled: true, mode: 'hold', accelerator: 'Control+Alt+D', label: '⌃⌥D', holdLabel: 'Fn', holdNote: 'If Fn opens the emoji picker, set it to Do Nothing.', holdState: 'ready', holdError: null, canOpenPrivacy: false, state: 'off', error: null, available: true, reason: null, hint: null};
  const html = dictateAnywhereRowHTML({info, busy: false, recording: false, error: null}, h);
  assert.match(html, /Hold Fn in any app and speak; let go to type/);
  assert.match(html, /Do Nothing/);
  assert.match(html, /data-act="dictate:record"[^>]*>Use a key combination…/);
  assert.doesNotMatch(html, /dictate:hold"/);
  assert.doesNotMatch(html, /dictate:privacy/);
  assert.doesNotMatch(html, /tk-help--warn/);

  const untrusted = dictateAnywhereRowHTML({info: Object.assign({}, info, {holdState: 'untrusted', canOpenPrivacy: true,
    holdError: 'Holding Fn needs Accessibility. Until then ⌃⌥D starts and ends a take.', hint: 'Typing into other apps needs Accessibility'}), busy: false, recording: false, error: null}, h);
  assert.match(untrusted, /tk-help--warn[^>]*>Holding Fn needs Accessibility/, 'the hold line wins over the paste hint');
  assert.match(untrusted, /data-act="dictate:privacy"[^>]*>Open Privacy Settings/);

  const win = dictateAnywhereRowHTML({info: Object.assign({}, info, {holdLabel: 'Ctrl+Win', holdNote: null}), busy: false, recording: false, error: null}, h);
  assert.match(win, /Hold Ctrl\+Win in any app/);
});

test('the page loads the row after the quick entry recorder and before renderer.js; the hooks are in place', () => {
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = index.indexOf('src="dictate-anywhere-settings.js"');
  assert.ok(at > index.indexOf('src="quick-entry-settings.js"') && at < index.indexOf('src="renderer.js"'));
  const r = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(r, /dictateAnywhereRowHTML\(DA, \{esc, setSwitchHTML\}\)/);
  assert.match(r, /a\.startsWith\('dictate:'\)/);
  assert.match(r, /dictateAnywhereRefresh\(\)/);
  const pill = readFileSync(new URL('../renderer/dictate-anywhere.html', import.meta.url), 'utf8');
  assert.match(pill, /src="dictate-anywhere\.js"/);
  assert.match(readFileSync(new URL('../renderer/dictate-anywhere.js', import.meta.url), 'utf8'), /addModule\('voice-worklet\.js'\)/);
});
