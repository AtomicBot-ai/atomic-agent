// Unit tests for renderer/studio/mask-painter.js (ATO-807): the pure rules of
// the Inpaint brush. The dialog itself is checked by hand on the second Mac.
// Run: node --test test/studio-mask-painter.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const M = req('../renderer/studio/mask-painter.js');

test('a pointer maps to source pixels, whatever the zoom', () => {
  const rect = {left: 100, top: 50, width: 512, height: 256};   // a 2048 × 1024 picture shown at a quarter
  assert.deepEqual(M.smaskPoint(100, 50, rect, 2048, 1024), {x: 0, y: 0});
  assert.deepEqual(M.smaskPoint(356, 178, rect, 2048, 1024), {x: 1024, y: 512});
  assert.deepEqual(M.smaskPoint(612, 306, rect, 2048, 1024), {x: 2048, y: 1024});
  assert.deepEqual(M.smaskPoint(0, 9999, rect, 2048, 1024), {x: 0, y: 1024}, 'outside the picture: clamped to its edge');
});

test('the brush is sized on screen: the same screen width covers more source pixels on a big picture', () => {
  assert.equal(M.smaskBrushPx(40, 512, 2048), 160);
  assert.equal(M.smaskBrushPx(40, 1024, 1024), 40);
  assert.equal(M.smaskBrushPx(9999, 1000, 1000), M.SMASK_MAX, 'size kept inside the slider range');
  assert.equal(M.smaskBrushPx(0, 1000, 1000), M.SMASK_DEFAULT, 'no size: the default');
});

test('[ and ] step the size and stay in range', () => {
  assert.ok(M.smaskStep(40, 1) > 40);
  assert.ok(M.smaskStep(40, -1) < 40);
  assert.equal(M.smaskStep(M.SMASK_MAX, 1), M.SMASK_MAX);
  assert.equal(M.smaskStep(M.SMASK_MIN, -1), M.SMASK_MIN);
});

test('an empty layer is not a mask; one painted pixel is', () => {
  const px = new Uint8ClampedArray(4 * 4);
  assert.equal(M.smaskAnyPainted(px), false);
  px[4 * 2 + 3] = 255;
  assert.equal(M.smaskAnyPainted(px), true);
});

test('a saved mask comes back as the layer: white painted, black clear', () => {
  const px = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
  M.smaskMaskToLayer(px);
  assert.equal(px[3], 255, 'white → fully painted');
  assert.equal(px[7], 0, 'black → not painted');
});
