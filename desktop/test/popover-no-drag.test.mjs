import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ATO-2009: the composer popovers (the add-provider wizard among them) are painted over the
// toolbar's drag band in a small window. Chromium only subtracts `no-drag` elements from a drag
// region, so without this rule a click on the wizard's address field there dragged the window.

const css = readFileSync(new URL('../renderer/css/popovers.css', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../renderer/css/shell.css', import.meta.url), 'utf8');

test('the toolbar band is still a drag region (the reason for the rule)', () => {
  assert.match(shell, /body\.electron #toolbar\{[^}]*-webkit-app-region:drag/);
});

test('every composer popover declares no-drag, as #settings does', () => {
  assert.match(css, /body\.electron \.popover\{-webkit-app-region:no-drag\}/);
});
