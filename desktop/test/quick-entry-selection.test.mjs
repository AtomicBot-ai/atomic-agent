// ATO-985: the selected text in the quick-entry box. The box's pure half
// (renderer/quick-entry-selection.js), the Settings row
// (renderer/quick-entry-settings.js) and the saved choice
// (main/selected-text.ts, against the built output).
// Run: npm run build && npm run test:unit
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {QE_SELECTION_ACTIONS, qeSelectionPreview, qeComposeWithSelection} = require('../renderer/quick-entry-selection.js');
const {quickEntryRowHTML, qeSelectionRowHTML} = require('../renderer/quick-entry-settings.js');
const T = require('../out/main/selected-text.js');

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, {recursive: true, force: true}); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'sel-')); dirs.push(d); return d; };
const h = {esc: (s) => String(s).replace(/</g, '&lt;'), setSwitchHTML: (o) => '<button data-act="' + o.act + '" data-on="' + !!o.on + '"' + (o.disabled ? ' disabled' : '') + '></button>'};

test('four actions, each a prompt that ends in a colon', () => {
  assert.deepEqual(QE_SELECTION_ACTIONS.map((a) => a.label), ['Rewrite', 'Translate', 'Explain', 'Summarize']);
  for (const a of QE_SELECTION_ACTIONS) assert.match(a.prompt, /:$/);
});

test('the chip shows one line, capped with an ellipsis', () => {
  assert.equal(qeSelectionPreview('  one\n\ttwo   three '), 'one two three');
  const long = qeSelectionPreview('word '.repeat(100), 40);
  assert.ok(long.length <= 40);
  assert.ok(long.endsWith('…'));
});

test('the message: the request, then the selection quoted line by line', () => {
  assert.equal(qeComposeWithSelection('Explain this:', 'a\r\n\r\nb'), 'Explain this:\n\n> a\n>\n> b');
  assert.equal(qeComposeWithSelection('  hi  ', ''), 'hi', 'no selection: the request alone');
  assert.equal(qeComposeWithSelection('', 'x'), '> x');
});

test('the box loads the helper before its own script', () => {
  const html = readFileSync(new URL('../renderer/quick-entry.html', import.meta.url), 'utf8');
  const at = html.indexOf('src="quick-entry-selection.js"');
  assert.ok(at > 0 && at < html.indexOf('src="quick-entry.js"'));
  assert.match(html, /id="qe-sel"[^>]* hidden/);
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

test('the saved choice: missing, bad and good files', () => {
  assert.deepEqual(T.parseSelectedTextPref(null), {use: null});
  assert.deepEqual(T.parseSelectedTextPref('nope'), {use: null});
  assert.deepEqual(T.parseSelectedTextPref('{"use":"yes"}'), {use: null});
  assert.deepEqual(T.parseSelectedTextPref('{"use":false}'), {use: false});
  const d = tmp();
  assert.deepEqual(T.readSelectedTextPref(d), {use: null});
  assert.equal(T.writeSelectedTextPref(d, {use: true}), true);
  assert.deepEqual(T.readSelectedTextPref(d), {use: true});
  writeFileSync(T.selectedTextPrefPath(d), '{"use":false}\n');
  assert.deepEqual(T.readSelectedTextPref(d), {use: false});
  assert.match(readFileSync(T.selectedTextPrefPath(d), 'utf8'), /"use":false/);
});

test('unset: on for macOS with Accessibility only; Windows and Linux opt in', () => {
  assert.equal(T.selectedTextInUse({use: null}, 'darwin', true), true);
  assert.equal(T.selectedTextInUse({use: null}, 'darwin', false), false);
  assert.equal(T.selectedTextInUse({use: null}, 'win32', true), false);
  assert.equal(T.selectedTextInUse({use: null}, 'linux', true), false);
  assert.equal(T.selectedTextInUse({use: true}, 'win32', true), true);
  assert.equal(T.selectedTextInUse({use: true}, 'darwin', false), false, 'no key press without the permission');
  assert.equal(T.selectedTextInUse({use: false}, 'darwin', true), false);
});

test('what Settings shows, and a write checked', () => {
  assert.deepEqual(T.selectedTextInfo({use: null}, 'darwin', true), {ok: true, on: true, hint: null});
  assert.deepEqual(T.selectedTextInfo({use: null}, 'darwin', false), {ok: true, on: false, hint: T.SELECTED_TEXT_ACCESSIBILITY_HINT});
  assert.deepEqual(T.selectedTextInfo({use: true}, 'darwin', false), {ok: true, on: true, hint: T.SELECTED_TEXT_ACCESSIBILITY_HINT});
  assert.deepEqual(T.selectedTextInfo({use: null}, 'linux', true), {ok: true, on: false, hint: null});
  assert.deepEqual(T.mergeSelectedTextPref({use: true}), {ok: true, pref: {use: true}});
  assert.equal(T.mergeSelectedTextPref({use: 'on'}).ok, false);
  assert.equal(T.mergeSelectedTextPref(null).ok, false);
});
