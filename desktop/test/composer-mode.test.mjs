// W2: the composer's mode chip (renderer/composer-mode.js). Chat · Goal ·
// Run overnight · Voice conversation, one chip beside "Ask first", and a
// composer field that holds only "+", the mic and send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../renderer/composer-mode.js');

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const deps = {esc: (s) => String(s), ic: (n) => '<svg data-i="' + n + '"></svg>'};

test('the mode on screen: a conversation, then a goal, else Chat', () => {
  assert.equal(M.cmodeCurrent({conv: 'off', goalFormOpen: false, goalStatus: null}), 'chat');
  assert.equal(M.cmodeCurrent({conv: 'off', goalFormOpen: true, goalStatus: null}), 'goal');
  assert.equal(M.cmodeCurrent({conv: 'off', goalFormOpen: false, goalStatus: 'active'}), 'goal');
  assert.equal(M.cmodeCurrent({conv: 'off', goalFormOpen: false, goalStatus: 'complete'}), 'chat');
  assert.equal(M.cmodeCurrent({conv: 'listening', goalFormOpen: true, goalStatus: 'active'}), 'voice');
  assert.equal(M.cmodeCurrent(null), 'chat');
});

test('four rows, each with a one-line hint; no Voice conversation without dictation', () => {
  assert.deepEqual(M.cmodeRows(true).map((r) => r.id), ['chat', 'goal', 'overnight', 'voice']);
  assert.deepEqual(M.cmodeRows(false).map((r) => r.id), ['chat', 'goal', 'overnight']);
  for (const r of M.CMODE_ROWS) assert.ok(r.hint && !r.hint.includes('—'), r.id);
  assert.match(M.CMODE_ROWS.find((r) => r.id === 'voice').hint, /⇧⌘J/);
});

test('the chip names the mode; the menu is always emitted, hidden while closed', () => {
  const chip = M.cmodePickChipHTML(deps);
  assert.match(chip, /class="cchip cmodepick"/);
  assert.match(chip, /data-cmode-open="1" data-conv="1" data-id="chat"/);
  assert.match(chip, /<span class="cval">Chat<\/span>/);
  const menu = M.cmodeMenuHTML(deps);
  assert.match(menu, /id="cmodemenu" role="menu" aria-label="Mode" hidden/);
  assert.match(menu, /data-cmode="chat" data-conv="1"/);
  assert.match(menu, /<span class="ml">Run overnight<\/span><span class="cap">/);
  assert.match(menu, /class="cmoderow on" role="menuitemradio" aria-checked="true" data-cmode="chat"/);
});

test('wired: the composer draws "+", mic and send, then the chip beside the permission chip', () => {
  const r = src('../renderer/renderer.js');
  assert.match(r, /attButtonHTML\(\) \+ micButton\(\) \+ sendButton\(\) \+ '<\/div>'/);
  assert.doesNotMatch(r, /wsnapButtonHTML|goalButtonHTML|convButtonHTML/);
  assert.match(r, /cmodePickChipHTML\(\{esc, ic\}\) : ''\)\n\s+\+ codingModeChip\(\)/);
  assert.match(r, /cmodeMenuHTML\(\{esc, ic\}\)/);
  assert.doesNotMatch(src('../renderer/converse.js'), /function convButtonHTML/);
  assert.doesNotMatch(src('../renderer/goal-card.js'), /function goalButtonHTML/);
  assert.doesNotMatch(src('../renderer/attachments.js'), /data-ovn="open"/);
  const html = src('../renderer/index.html');
  const at = (f) => html.indexOf('<script src="' + f + '"');
  assert.ok(at('composer-mode.js') > at('goal-actions.js') && at('composer-mode.js') > at('overnight.js') && at('composer-mode.js') < at('renderer.js'));
});

test('W2: no context ring in the composer row; the driver still reads its figure', () => {
  const r = src('../renderer/renderer.js');
  assert.doesNotMatch(r, /function ringChip|class="ctxring|cchip ctxbtn/);
  assert.match(r, /function contextChip\(\) \{[\s\S]{0,400}return usageChip\(\);\n\}/);
  assert.match(r, /window\.__ctxChip = \(\) => ctxChipTip\(\);/);
  assert.doesNotMatch(src('../renderer/css/composer.css'), /\.ctxring/);
});
