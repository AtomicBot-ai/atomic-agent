// Unit tests for test/visual/matrix.mjs (ATO-2761): which windows, scales,
// themes and screens the visual diff shoots. Run: npm run test:unit
// They sit at test/ top level because test:unit's glob is test/*.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildMatrix, DEFAULT_VARIANTS, parseVariant, shotName, splitList, variantLabel } from "./visual/matrix.mjs";

const SCREENS = [{ id: "chat-empty" }, { id: "settings-general" }, { id: "model-picker" }];

test("parseVariant reads size and scale, scale defaults to 1", () => {
  assert.deepEqual(parseVariant("1470x923@1.5"), { width: 1470, height: 923, scale: 1.5 });
  assert.deepEqual(parseVariant(" 1100x700 "), { width: 1100, height: 700, scale: 1 });
  assert.deepEqual(parseVariant("1920x1080@2x"), { width: 1920, height: 1080, scale: 2 });
});

test("parseVariant refuses nonsense instead of shooting a wrong size", () => {
  assert.throws(() => parseVariant("big"), /cannot read the window size/);
  assert.throws(() => parseVariant("1470x923@0"), /out of range/);
  assert.throws(() => parseVariant("1470x923@9"), /out of range/);
});

test("the default matrix is three windows at 1x plus the middle one at 1.5x, both themes", () => {
  const m = buildMatrix({ screens: SCREENS, env: {} });
  assert.deepEqual(m.variants.map(variantLabel), ["1100x700-1x", "1470x923-1x", "1470x923-1.5x", "1920x1080-1x"]);
  assert.equal(DEFAULT_VARIANTS.split(",").length, 4);
  assert.deepEqual(m.themes, ["light", "dark"]);
  assert.equal(m.shots.length, 4 * 2 * SCREENS.length);
  assert.deepEqual(m.unknownScreens, []);
});

test("shots are grouped by variant, then theme, then screen", () => {
  const m = buildMatrix({ screens: SCREENS, env: { VISUAL_VARIANTS: "1100x700,1470x923@1.5" } });
  assert.deepEqual(m.shots.slice(0, 4).map((s) => s.name), [
    "chat-empty--light--1100x700-1x",
    "settings-general--light--1100x700-1x",
    "model-picker--light--1100x700-1x",
    "chat-empty--dark--1100x700-1x",
  ]);
  assert.equal(m.shots.at(-1).name, "model-picker--dark--1470x923-1.5x");
});

test("env narrows the matrix; duplicates are dropped; unknown screens are reported", () => {
  const m = buildMatrix({ screens: SCREENS, env: {
    VISUAL_VARIANTS: "1470x923@1, 1470x923@1 ,1470x923",
    VISUAL_THEMES: "dark",
    VISUAL_SCREENS: "model-picker,nope",
  } });
  assert.equal(m.variants.length, 1);
  assert.deepEqual(m.themes, ["dark"]);
  assert.deepEqual(m.screens.map((s) => s.id), ["model-picker"]);
  assert.deepEqual(m.unknownScreens, ["nope"]);
  assert.deepEqual(m.shots.map((s) => s.name), ["model-picker--dark--1470x923-1x"]);
});

test("an unknown theme throws", () => {
  assert.throws(() => buildMatrix({ screens: SCREENS, env: { VISUAL_THEMES: "sepia" } }), /unknown theme/);
});

test("shot names are file-name safe on Windows", () => {
  const n = shotName("settings-models", "dark", { width: 1470, height: 923, scale: 1.5 });
  assert.equal(n, "settings-models--dark--1470x923-1.5x");
  assert.doesNotMatch(n, /[<>:"/\\|?*@ ]/);
});

test("splitList trims, drops empties and keeps first order", () => {
  assert.deepEqual(splitList(" a, b,,a ,c "), ["a", "b", "c"]);
  assert.deepEqual(splitList(undefined), []);
});
