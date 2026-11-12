import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DLI_POP_W, dlPopoverSpot, dlIndicatorKey } = require('../renderer/dl-indicator.js');

// ATO-1185: downloads are an icon in the sidebar header; the list is its popover under the header.

const rect = (left, top, width, height) => ({left, top, width, height, right: left + width, bottom: top + height});
const WIN = rect(8, 8, 1264, 804);

test('with the sidebar open the popover hangs under the header, left-aligned with it', () => {
  const sidebar = rect(8, -44, 260, 856);
  const head = rect(24, 60, 236, 40);
  const spot = dlPopoverSpot(WIN, sidebar, head, rect(8, 8, 1264, 52), 8, 16);
  assert.equal(spot.left, 16);       // head.left - win.left
  assert.equal(spot.top, 100);       // head.bottom - win.top + gap
  assert.equal(spot.room, 804 - 100 - 16);
  // It stays near the sidebar: at most a little past its right edge, never over the chat column.
  assert.ok(WIN.left + spot.left + DLI_POP_W <= sidebar.right + 48);
});

test('on the icon rail the popover stands beside the rail, level with the header', () => {
  const win = rect(8, 8, 924, 604);
  const sidebar = rect(8, 60, 52, 552);
  const head = rect(18, 70, 32, 36);
  const spot = dlPopoverSpot(win, sidebar, head, rect(8, 8, 924, 52), 8, 16);
  assert.equal(spot.left, 52 + 8);   // sidebar.right - win.left + gap
  assert.equal(spot.top, 62);        // head.top - win.top
});

test('without a sidebar on screen it falls back to the top-left corner under the toolbar', () => {
  const spot = dlPopoverSpot(WIN, rect(0, 0, 0, 0), null, rect(8, 8, 1264, 52), 8, 16);
  assert.equal(spot.left, 16);
  assert.equal(spot.top, 52 + 8);
});

test('the popover never runs past the window right edge and keeps a usable list height', () => {
  const tiny = rect(0, 0, 300, 200);
  const spot = dlPopoverSpot(tiny, rect(0, 0, 52, 200), rect(10, 150, 32, 36), null, 8, 16);
  assert.ok(spot.left + DLI_POP_W <= Math.max(16 + DLI_POP_W, tiny.width - 16));
  assert.ok(spot.room >= 120);
});

test('the header icon key changes only with what the icon says', () => {
  assert.equal(dlIndicatorKey(0, false, false, true), '');
  const a = dlIndicatorKey(2, false, true, true);
  assert.equal(dlIndicatorKey(2, false, true, true), a);
  assert.notEqual(dlIndicatorKey(3, false, true, true), a);
  assert.notEqual(dlIndicatorKey(2, true, true, true), a);
  assert.notEqual(dlIndicatorKey(2, false, false, true), a);
  assert.notEqual(dlIndicatorKey(2, false, true, false), a);
});

test('index.html loads dl-indicator.js before renderer.js', () => {
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const helper = index.indexOf('<script src="dl-indicator.js">');
  assert.ok(helper > 0);
  assert.ok(helper < index.indexOf('<script src="renderer.js">'));
});

test('the sidebar header carries the icon slot and the card no longer draws the badge itself', () => {
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(src, /<span class="sb-dl" data-k="' \+ esc\(DLC\.indKey\) \+ '">' \+ DLC\.ind \+ '<\/span><\/div>'/);
  assert.match(src, /el\.innerHTML = dlCardHTML\(rows\);/);
  assert.doesNotMatch(src, /DLC\.collapsed \? dlCardBadgeHTML\(rows\) : dlCardHTML\(rows\)/);
  const css = readFileSync(new URL('../renderer/css/shell.css', import.meta.url), 'utf8');
  assert.match(css, /#dlcard\{position:absolute;left:16px;top:96px;z-index:15;width:min\(288px/);
  assert.match(css, new RegExp('min\\(' + DLI_POP_W + 'px'));
});
