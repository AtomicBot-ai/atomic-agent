import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const {qeAcceleratorFromKey, quickEntryRowHTML} = createRequire(import.meta.url)('../renderer/quick-entry-settings.js');

// ATO-523: Settings › General records the quick entry combo from a keydown;
// main checks it (test/quick-entry.test.mjs).

const key = (code, mods = {}) => Object.assign({code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false}, mods);

test('a keydown becomes an accelerator by its physical key', () => {
  assert.equal(qeAcceleratorFromKey(key('Space', {metaKey: true, shiftKey: true}), true), 'Command+Shift+Space');
  assert.equal(qeAcceleratorFromKey(key('KeyK', {ctrlKey: true, altKey: true}), false), 'Control+Alt+K');
  assert.equal(qeAcceleratorFromKey(key('KeyK', {altKey: true}), true), 'Alt+K', 'Option+K is K, not the symbol Option makes');
  assert.equal(qeAcceleratorFromKey(key('Digit1', {ctrlKey: true}), false), 'Control+1');
  assert.equal(qeAcceleratorFromKey(key('F13'), true), 'F13');
  assert.equal(qeAcceleratorFromKey(key('Slash', {metaKey: true}), true), 'Command+/');
  assert.equal(qeAcceleratorFromKey(key('Enter', {metaKey: true}), false), 'Super+Return', 'the Windows key is Super');
  assert.equal(qeAcceleratorFromKey(key('Numpad5', {altKey: true}), false), 'Alt+num5');
});

test('modifiers alone, unknown keys and nothing wait for the next key', () => {
  for (const code of ['MetaLeft', 'ShiftLeft', 'ControlRight', 'AltLeft', 'CapsLock', 'IntlBackslash', '']) {
    assert.equal(qeAcceleratorFromKey(key(code, {metaKey: true}), true), null, code);
  }
  assert.equal(qeAcceleratorFromKey(null, true), null);
  assert.equal(qeAcceleratorFromKey(key('constructor', {metaKey: true}), true), null, 'no prototype keys');
});

const h = {esc: (s) => String(s).replace(/</g, '&lt;'), setSwitchHTML: (o) => '<button data-act="' + o.act + '" data-on="' + !!o.on + '"' + (o.disabled ? ' disabled' : '') + '></button>'};

test('the row: the combo on the button, the switch, and the "taken" line', () => {
  const st = {info: {ok: true, enabled: true, accelerator: 'CommandOrControl+Shift+Space', label: '⌘⇧Space', state: 'registered', error: null}, busy: false, recording: false, error: null};
  const html = quickEntryRowHTML(st, h);
  assert.match(html, /Quick entry shortcut/);
  assert.match(html, /data-act="quickentry:record"[^>]*>⌘⇧Space · Change…/);
  assert.match(html, /data-act="quickentry:toggle" data-on="true"/);
  assert.doesNotMatch(html, /tk-help--warn/);
  const taken = quickEntryRowHTML(Object.assign({}, st, {info: Object.assign({}, st.info, {state: 'taken', error: 'This shortcut is taken by another app. Choose another one.'})}), h);
  assert.match(taken, /tk-help--warn[^>]*>This shortcut is taken by another app/);
});

test('while recording: Cancel instead of Change…, the switch held', () => {
  const st = {info: {enabled: true, label: '⌘⇧Space'}, busy: false, recording: true, error: null};
  const html = quickEntryRowHTML(st, h);
  assert.match(html, /data-act="quickentry:cancel"/);
  assert.doesNotMatch(html, /quickentry:record/);
  assert.match(html, /data-act="quickentry:toggle"[^>]* disabled/);
  assert.match(html, /Press the new combination now/);
});

test('before main answers, nothing can be pressed', () => {
  const html = quickEntryRowHTML({info: null, busy: false, recording: false, error: null}, h);
  assert.match(html, /data-act="quickentry:record"[^>]* disabled/);
  assert.match(html, /data-act="quickentry:toggle"[^>]* disabled/);
});

test('the page loads the script before renderer.js and the hooks are in place', () => {
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = index.indexOf('src="quick-entry-settings.js"');
  assert.ok(at > 0 && at < index.indexOf('src="renderer.js"'));
  const r = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(r, /quickEntryRowHTML\(QE, \{esc, setSwitchHTML\}\)/);
  assert.match(r, /a\.startsWith\('quickentry:'\)/);
  assert.match(r, /quickEntryBoot\(\);/);
});
