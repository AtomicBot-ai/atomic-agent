// ATO-985: the selected text in the hotkey's mini chat window. The page's
// pure half (renderer/mini-chat-selection.js), its wiring in
// renderer/mini-chat.js and quick-entry-window.ts (read from the sources),
// the Settings row (renderer/quick-entry-settings.js) and the saved choice
// with Translate's last language (main/selected-text.ts, against the built
// output).
// Run: npm run build && npm run test:unit
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../renderer/mini-chat-selection.js');
const {MC_SELECTION_ACTIONS, MC_TRANSLATE_LANGUAGES, mcSelectionPreview, mcComposeWithSelection} = S;
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const {quickEntryRowHTML, qeSelectionRowHTML} = require('../renderer/quick-entry-settings.js');
const T = require('../out/main/selected-text.js');

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, {recursive: true, force: true}); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'sel-')); dirs.push(d); return d; };
const h = {esc: (s) => String(s).replace(/</g, '&lt;'), setSwitchHTML: (o) => '<button data-act="' + o.act + '" data-on="' + !!o.on + '"' + (o.disabled ? ' disabled' : '') + '></button>'};

test('four actions, each a prompt that ends in a colon', () => {
  assert.deepEqual(MC_SELECTION_ACTIONS.map((a) => a.label), ['Rewrite', 'Translate', 'Explain', 'Summarize']);
  for (const a of MC_SELECTION_ACTIONS) assert.match(S.mcSelectionPrompt(a, 'German'), /:$/);
});

test('Translate names the language picked', () => {
  const tr = MC_SELECTION_ACTIONS.find((a) => a.id === 'translate');
  assert.equal(S.mcSelectionPrompt(tr, 'Spanish'), 'Translate this into Spanish:');
  assert.equal(S.mcSelectionPrompt(tr, null), 'Translate this into English:');
  const ex = MC_SELECTION_ACTIONS.find((a) => a.id === 'explain');
  assert.equal(S.mcSelectionPrompt(ex, 'Spanish'), 'Explain this:', 'the others ignore it');
});

test('the language list: the system language first, then the common ones, each once', () => {
  assert.deepEqual(MC_TRANSLATE_LANGUAGES, ['English', 'Russian', 'Spanish', 'German', 'French', 'Chinese', 'Japanese', 'Portuguese']);
  assert.deepEqual(S.mcLanguageOptions(null), MC_TRANSLATE_LANGUAGES);
  assert.deepEqual(S.mcLanguageOptions('Ukrainian'), ['Ukrainian', ...MC_TRANSLATE_LANGUAGES]);
  const ru = S.mcLanguageOptions('Russian');
  assert.equal(ru[0], 'Russian');
  assert.equal(ru.filter((l) => l === 'Russian').length, 1, 'not listed twice');
  assert.equal(ru.length, MC_TRANSLATE_LANGUAGES.length);
  // Picked under another system language: kept in the list, after the system one.
  assert.deepEqual(S.mcLanguageOptions('English', 'Ukrainian').slice(0, 2), ['English', 'Ukrainian']);
  assert.equal(S.mcLanguageOptions('English', 'german').filter((l) => l.toLowerCase() === 'german').length, 1);
});

test('the system language is named in English from its base code', () => {
  const names = {of: (c) => ({ru: 'Russian', uk: 'Ukrainian', en: 'English'})[c] || c};
  assert.equal(S.mcLanguageName('ru-RU', names), 'Russian');
  assert.equal(S.mcLanguageName('uk_UA', names), 'Ukrainian');
  assert.equal(S.mcLanguageName('xx', names), null, 'a code with no name');
  assert.equal(S.mcLanguageName('', names), null);
  assert.equal(S.mcLanguageName('ru', null), null);
  assert.equal(S.mcLanguageName('ru', {of: () => { throw new Error('no'); }}), null);
});

test('Translate starts on the language used last, else the first in the list', () => {
  assert.equal(S.mcDefaultLanguage('Japanese', ['Russian', 'English']), 'Japanese');
  assert.equal(S.mcDefaultLanguage(null, ['Russian', 'English']), 'Russian');
  assert.equal(S.mcDefaultLanguage('', []), 'English');
});

test('the chip shows one line, capped with an ellipsis', () => {
  assert.equal(mcSelectionPreview('  one\n\ttwo   three '), 'one two three');
  const long = mcSelectionPreview('word '.repeat(100), 40);
  assert.ok(long.length <= 40);
  assert.ok(long.endsWith('…'));
});

test('the message: the request, then the selection quoted line by line', () => {
  assert.equal(mcComposeWithSelection('Explain this:', 'a\r\n\r\nb'), 'Explain this:\n\n> a\n>\n> b');
  assert.equal(mcComposeWithSelection('  hi  ', ''), 'hi', 'no selection: the request alone');
  assert.equal(mcComposeWithSelection('', 'x'), '> x');
});

test('the mini chat page loads the helper before its own script, the chip hidden until there is a selection', () => {
  const html = src('../renderer/mini-chat.html');
  const at = html.indexOf('<script src="mini-chat-selection.js">');
  assert.ok(at > 0 && at < html.indexOf('<script src="mini-chat.js">'));
  assert.match(html, /id="mc-sel"[^>]* hidden/);
  assert.match(html, /id="mc-lang"[^>]*role="menu"[^>]* hidden/);
  for (const id of ['mc-sel-text', 'mc-actions']) assert.ok(html.includes(`id="${id}"`), id);
});

test('the mini chat page: the chip from quickEntryOpened, sent once with the first message, Translate remembered', () => {
  const js = src('../renderer/mini-chat.js');
  assert.match(js, /typeof opened\.selection === 'string' && opened\.selection/, 'reads the selection main kept');
  assert.match(js, /BR\.selectedTextGet\(\)/, 'asks for the language used last');
  assert.match(js, /showSelection\(opened\.selection, info && info\.translateTo\)/);
  assert.match(js, /mcComposeWithSelection\(typed, selection\)/, 'the selection is quoted under the request');
  assert.match(js, /if \(selection\) dropSelection\(\);/, 'then the chip goes away');
  assert.match(js, /content: text\.trim\(\)/, 'the composed message is what is sent');
  assert.match(js, /BR\.selectedTextSet\(\{translateTo: l\}\)/, 'a language picked is saved');
  assert.match(js, /mcSelectionPrompt\(translate, l\)/, 'and prefills the message');
  // Esc in the language menu closes the menu only: the page closes on an Esc nobody took.
  const menuEsc = js.indexOf("if (e.key !== 'Escape') return;");
  assert.ok(menuEsc > 0 && /e\.preventDefault\(\);\s*closeLanguages\(\);/.test(js.slice(menuEsc, menuEsc + 120)));
  assert.match(js, /e\.key === 'Escape' && !e\.defaultPrevented\) window\.close\(\)/);
});

test('the hotkey reads the selection before the mini chat opens; the menu and the tray do not', () => {
  const qw = src('../main/quick-entry-window.ts');
  assert.match(qw, /w\.grabSelection\(\)\.catch\([^\n]*\)\.then\(\(grab\) => \{/);
  assert.match(qw, /ipcMain\.handle\("app:quickEntryOpened", \(\) => \(\{ draft, label: [^\n]*, selection, notice \}\)\)/);
  assert.match(qw, /win\.loadFile\(miniChatPagePath\(__dirname\)\)/, 'the page with the chip is the mini chat');
  const at = qw.indexOf('const show = () => {');
  const body = qw.slice(at, qw.indexOf('\n  };', at));
  assert.doesNotMatch(body, /grabSelection|open\(\)/, 'File › New Mini Chat and the tray never press the copy keys');
  assert.match(body, /create\(null\)/);
  assert.ok(!src('../renderer/quick-entry.html').includes('mini-chat-selection.js'), 'the old box page has no chip');
});

test('the Settings row: the switch, the Accessibility hint, nothing before main answers', () => {
  const on = qeSelectionRowHTML({ok: true, on: true, hint: null}, false, h);
  assert.match(on, /Use selected text/);
  assert.match(on, /data-act="quickentry:selection" data-on="true"/);
  assert.doesNotMatch(on, /tk-help--warn/);
  const hint = qeSelectionRowHTML({ok: true, on: false, hint: T.SELECTED_TEXT_ACCESSIBILITY_HINT}, false, h);
  assert.match(hint, /tk-help--warn[^>]*>Needs Accessibility/);
  assert.match(qeSelectionRowHTML(null, false, h), /data-act="quickentry:selection"[^>]* disabled/);
  const st = {info: {enabled: true, label: '⌘⇧Space'}, busy: false, recording: false, error: null};
  assert.doesNotMatch(quickEntryRowHTML(st, h), /Use selected text/, 'the old callers get the old row');
  assert.match(quickEntryRowHTML(Object.assign({}, st, {sel: null, selBusy: false}), h), /Use selected text/);
});

const N = {use: null, translateTo: null};

test('the saved choice: missing, bad and good files', () => {
  assert.deepEqual(T.parseSelectedTextPref(null), N);
  assert.deepEqual(T.parseSelectedTextPref('nope'), N);
  assert.deepEqual(T.parseSelectedTextPref('{"use":"yes"}'), N);
  assert.deepEqual(T.parseSelectedTextPref('{"use":false}'), {use: false, translateTo: null}, 'a file from before the picker');
  assert.deepEqual(T.parseSelectedTextPref('{"use":true,"translateTo":"Spanish"}'), {use: true, translateTo: 'Spanish'});
  assert.deepEqual(T.parseSelectedTextPref('{"use":true,"translateTo":"<b>x</b>"}'), {use: true, translateTo: null}, 'not a language name');
  const d = tmp();
  assert.deepEqual(T.readSelectedTextPref(d), N);
  assert.equal(T.writeSelectedTextPref(d, {use: true, translateTo: null}), true);
  assert.deepEqual(T.readSelectedTextPref(d), {use: true, translateTo: null});
  writeFileSync(T.selectedTextPrefPath(d), '{"use":false}\n');
  assert.deepEqual(T.readSelectedTextPref(d), {use: false, translateTo: null});
  assert.match(readFileSync(T.selectedTextPrefPath(d), 'utf8'), /"use":false/);
});

test('the language Translate used last is kept across restarts, beside the switch', () => {
  const d = tmp();
  // Picked in the mini chat with the switch never touched: the switch stays unset.
  const picked = T.mergeSelectedTextPref(T.readSelectedTextPref(d), {translateTo: 'Japanese'});
  assert.deepEqual(picked, {ok: true, pref: {use: null, translateTo: 'Japanese'}});
  assert.equal(T.writeSelectedTextPref(d, picked.pref), true);
  assert.deepEqual(T.readSelectedTextPref(d), {use: null, translateTo: 'Japanese'}, 'read back as the app starts');
  // Settings turning the switch off keeps the language.
  const off = T.mergeSelectedTextPref(T.readSelectedTextPref(d), {use: false});
  assert.deepEqual(off.pref, {use: false, translateTo: 'Japanese'});
  T.writeSelectedTextPref(d, off.pref);
  assert.equal(T.readSelectedTextPref(d).translateTo, 'Japanese');
  assert.equal(T.selectedTextInfo(T.readSelectedTextPref(d), 'darwin', true).translateTo, 'Japanese', 'the page gets it from app:selectedTextGet');
});

test('a language name is checked', () => {
  assert.equal(T.selectedTextLanguage('  Portuguese '), 'Portuguese');
  assert.equal(T.selectedTextLanguage('Chinese (Traditional)'), 'Chinese (Traditional)');
  assert.equal(T.selectedTextLanguage('Русский'), 'Русский');
  for (const bad of ['', ' ', 'x'.repeat(41), '../etc', '<i>', 42, null, '1English']) assert.equal(T.selectedTextLanguage(bad), null, String(bad));
});

test('unset: on for macOS with Accessibility only; Windows and Linux opt in', () => {
  assert.equal(T.selectedTextInUse(N, 'darwin', true), true);
  assert.equal(T.selectedTextInUse(N, 'darwin', false), false);
  assert.equal(T.selectedTextInUse(N, 'win32', true), false);
  assert.equal(T.selectedTextInUse(N, 'linux', true), false);
  assert.equal(T.selectedTextInUse({use: true, translateTo: null}, 'win32', true), true);
  assert.equal(T.selectedTextInUse({use: true, translateTo: null}, 'darwin', false), false, 'no key press without the permission');
  assert.equal(T.selectedTextInUse({use: false, translateTo: null}, 'darwin', true), false);
});

test('what Settings shows, and a write checked', () => {
  assert.deepEqual(T.selectedTextInfo(N, 'darwin', true), {ok: true, on: true, hint: null, openAccessibility: false, translateTo: null});
  assert.deepEqual(T.selectedTextInfo(N, 'darwin', false), {ok: true, on: false, hint: T.SELECTED_TEXT_ACCESSIBILITY_HINT, openAccessibility: true, translateTo: null});
  assert.deepEqual(T.selectedTextInfo({use: true, translateTo: null}, 'darwin', false), {ok: true, on: true, hint: T.SELECTED_TEXT_ACCESSIBILITY_HINT, openAccessibility: true, translateTo: null});
  assert.deepEqual(T.selectedTextInfo(N, 'linux', true), {ok: true, on: false, hint: null, openAccessibility: false, translateTo: null});
  assert.deepEqual(T.mergeSelectedTextPref(N, {use: true}), {ok: true, pref: {use: true, translateTo: null}});
  assert.deepEqual(T.mergeSelectedTextPref({use: true, translateTo: 'French'}, {use: false}).pref, {use: false, translateTo: 'French'});
  assert.equal(T.mergeSelectedTextPref(N, {use: 'on'}).ok, false);
  assert.equal(T.mergeSelectedTextPref(N, {translateTo: '<script>'}).ok, false);
  assert.equal(T.mergeSelectedTextPref(N, {}).ok, false);
  assert.equal(T.mergeSelectedTextPref(N, null).ok, false);
});

test('the Settings write asks macOS for Accessibility only when the switch is turned on, not on a language pick', () => {
  const ipc = src('../main/selected-text-ipc.ts');
  assert.match(ipc, /mergeSelectedTextPref\(pref, patch\)/);
  assert.match(ipc, /const turnedOn = merged\.pref\.use === true && pref\.use !== true;/);
  assert.match(ipc, /if \(turnedOn && w\.platform === "darwin" && !keystrokesAllowed\(false\)\) keystrokesAllowed\(true\);/);
});
