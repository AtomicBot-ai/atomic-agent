// ATO-1064: dictation into any app. The pure half (main/dictate-anywhere.ts,
// against the built output) and the Settings row
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
const Q = require('../out/main/quick-entry.js');
const {dictateAnywhereRowHTML} = require('../renderer/dictate-anywhere-settings.js');

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, {recursive: true, force: true}); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'da-')); dirs.push(d); return d; };
const h = {esc: (s) => String(s).replace(/</g, '&lt;'), setSwitchHTML: (o) => '<button data-act="' + o.act + '" data-on="' + !!o.on + '"' + (o.disabled ? ' disabled' : '') + '></button>'};

test('off by default, on a combo of its own that passes the check', () => {
  assert.deepEqual(D.DICTATE_DEFAULT_PREF, {enabled: false, accelerator: 'Control+Alt+D'});
  assert.deepEqual(Q.normalizeAccelerator(D.DICTATE_DEFAULT_ACCELERATOR), {ok: true, accelerator: 'Control+Alt+D'});
  assert.notEqual(D.DICTATE_DEFAULT_ACCELERATOR, Q.QUICK_ENTRY_DEFAULT_ACCELERATOR);
});

test('the saved pref: missing, broken and good files', () => {
  assert.deepEqual(D.parseDictatePref(null), D.DICTATE_DEFAULT_PREF);
  assert.deepEqual(D.parseDictatePref('{'), D.DICTATE_DEFAULT_PREF);
  assert.deepEqual(D.parseDictatePref('{"enabled":true,"accelerator":"Space"}'), {enabled: true, accelerator: 'Control+Alt+D'});
  assert.deepEqual(D.parseDictatePref('{"enabled":true,"accelerator":"alt+cmd+j"}'), {enabled: true, accelerator: 'Command+Alt+J'});
  const d = tmp();
  assert.deepEqual(D.readDictatePref(d), D.DICTATE_DEFAULT_PREF);
  assert.equal(D.writeDictatePref(d, {enabled: true, accelerator: 'Control+Alt+K'}), true);
  assert.deepEqual(D.readDictatePref(d), {enabled: true, accelerator: 'Control+Alt+K'});
  writeFileSync(D.dictatePrefPath(d), 'null');
  assert.deepEqual(D.readDictatePref(d), D.DICTATE_DEFAULT_PREF);
  assert.match(D.dictatePrefPath(d), /dictate-anywhere\.json$/);
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
  const info = {ok: true, enabled: true, accelerator: 'Control+Alt+D', label: '⌃⌥D', state: 'registered', error: null, available: true, reason: null, hint: null};
  const html = dictateAnywhereRowHTML({info, busy: false, recording: false, error: null}, h);
  assert.match(html, /Dictate into any app/);
  assert.match(html, /data-act="dictate:record"[^>]*>⌃⌥D · Change…/);
  assert.match(html, /data-act="dictate:toggle" data-on="true"/);
  assert.doesNotMatch(html, /tk-help--warn/);

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
