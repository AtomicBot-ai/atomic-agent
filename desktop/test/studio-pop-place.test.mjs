import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const P = req('../renderer/studio/pop-place.js');

/* ATO-2415: Studio › Image's model list ran past the top of the window. It sat
   on the field's bottom edge and grew upwards, capped by the whole column's
   height instead of the room above the field. */

const PAD = P.STUDIO_POP_PAD;
const box = {top: 0, bottom: 1200};

// The popover's top and bottom edges in client px, from a placement on `box`.
function edges(place, b = box) {
  const h = place.maxHeight;
  if (place.side === 'up') { const bottom = b.bottom - place.bottom; return {top: bottom - h, bottom}; }
  const top = b.top + place.top; return {top, bottom: top + h};
}

test("the reporter's case: a long list above a field in the middle of the column stays inside the column", () => {
  const field = {top: 700, bottom: 750};
  const p = P.studioPopPlace(field, box, 900);
  assert.equal(p.side, 'up');
  assert.equal(p.bottom, 450, 'still sits on the field\'s bottom edge');
  assert.equal(p.maxHeight, 750 - PAD, 'capped by the room above the field, not the column (1200 - 24)');
  const e = edges(p);
  assert.ok(e.top >= box.top + PAD && e.bottom <= box.bottom - PAD, JSON.stringify(e));
});

test('a field near the top of the column opens the list downwards, on the field\'s top edge', () => {
  const field = {top: 60, bottom: 110};
  const p = P.studioPopPlace(field, box, 600);
  assert.equal(p.side, 'down');
  assert.equal(p.top, 60);
  assert.equal(p.bottom, null);
  assert.equal(p.maxHeight, 1200 - PAD - 60);
  const e = edges(p);
  assert.ok(e.top >= box.top + PAD && e.bottom <= box.bottom - PAD, JSON.stringify(e));
});

test('a list that fits above keeps opening upwards even when there is more room below', () => {
  const p = P.studioPopPlace({top: 700, bottom: 750}, box, 300);
  assert.equal(p.side, 'up');
  assert.equal(p.bottom, 450);
  assert.ok(p.maxHeight >= 300);
});

test('a list that fits on neither side takes the side with more room, capped to it', () => {
  const low = P.studioPopPlace({top: 900, bottom: 950}, box, 5000);
  assert.equal(low.side, 'up');
  assert.equal(low.maxHeight, 950 - PAD);
  const high = P.studioPopPlace({top: 200, bottom: 250}, box, 5000);
  assert.equal(high.side, 'down');
  assert.equal(high.maxHeight, 1200 - PAD - 200);
});

test('an unknown height picks the side with more room', () => {
  assert.equal(P.studioPopPlace({top: 900, bottom: 950}, box, 0).side, 'up');
  assert.equal(P.studioPopPlace({top: 200, bottom: 250}, box, 0).side, 'down');
});

test('a field scrolled out of the column keeps the list inside the visible column', () => {
  // The narrow layout: the column scrolls, the popwrap moved up with the content.
  const scrolledBox = {top: -400, bottom: 800}, clip = {top: 0, bottom: 800};
  const below = P.studioPopPlace({top: 900, bottom: 950}, scrolledBox, 400, PAD, clip);
  const e = edges(below, scrolledBox);
  assert.ok(e.top >= clip.top + PAD && e.bottom <= clip.bottom - PAD, JSON.stringify({below, e}));
  const above = P.studioPopPlace({top: -100, bottom: -50}, scrolledBox, 400, PAD, clip);
  const e2 = edges(above, scrolledBox);
  assert.ok(e2.top >= clip.top + PAD && e2.bottom <= clip.bottom - PAD, JSON.stringify({above, e2}));
});

test('applying a placement sets one side, releases the other and caps the height', () => {
  const s = {};
  P.studioPopApply(s, {side: 'up', top: null, bottom: 450, maxHeight: 742});
  assert.deepEqual(s, {top: 'auto', bottom: '450px', maxHeight: '742px'});
  P.studioPopApply(s, {side: 'down', top: 60, bottom: null, maxHeight: 1132});
  assert.deepEqual(s, {top: '60px', bottom: 'auto', maxHeight: '1132px'});
});

test('images.js places the list through it and the page loads the module first', () => {
  const images = readFileSync(new URL('../renderer/studio/images.js', import.meta.url), 'utf8');
  assert.match(images, /studioPopApply\(pop\.style, studioPopPlace\(/);
  assert.doesNotMatch(images, /pop\.style\.bottom = Math\.max\(8/, 'the old bottom-only placement is gone');
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const place = html.indexOf('src="studio/pop-place.js"'), page = html.indexOf('src="studio/images.js"');
  assert.ok(place > 0 && page > place, 'pop-place.js is loaded before images.js');
});
