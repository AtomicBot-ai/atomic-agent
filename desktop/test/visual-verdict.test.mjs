// Unit tests for test/visual/verdict.mjs (ATO-2761): the diff threshold and
// what fails the run. Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULTS, formatPercent, judge, sortForReport, summarize, thresholdsFrom } from "./visual/verdict.mjs";

test("no baseline is new, never a failure", () => {
  const v = judge({ hasBaseline: false });
  assert.equal(v.status, "new");
  assert.equal(summarize([v]).exitCode, 0);
});

test("a size change is a change, whatever the pixels say", () => {
  assert.equal(judge({ hasBaseline: true, sizeMismatch: true, diffPixels: 0, totalPixels: 100 }).status, "changed");
});

test("at the limit is same, one pixel over is changed", () => {
  const total = 1_000_000;
  const limit = 0.001;
  assert.equal(judge({ hasBaseline: true, diffPixels: 1000, totalPixels: total }, limit).status, "same");
  assert.equal(judge({ hasBaseline: true, diffPixels: 1001, totalPixels: total }, limit).status, "changed");
  assert.equal(judge({ hasBaseline: true, diffPixels: 0, totalPixels: total }, limit).reason, "identical");
});

test("a softer CI limit lets the same diff through", () => {
  const c = { hasBaseline: true, diffPixels: 3000, totalPixels: 1_000_000 };
  assert.equal(judge(c, 0.001).status, "changed");
  assert.equal(judge(c, 0.005).status, "same");
});

test("thresholds come from env, with defaults, and refuse out-of-range values", () => {
  assert.deepEqual(thresholdsFrom({}), DEFAULTS);
  assert.deepEqual(thresholdsFrom({ VISUAL_PIXEL_THRESHOLD: "0.2", VISUAL_MAX_DIFF_RATIO: "0.005" }), { pixelThreshold: 0.2, maxDiffRatio: 0.005 });
  assert.throws(() => thresholdsFrom({ VISUAL_MAX_DIFF_RATIO: "5" }), /from 0 to 1/);
  assert.throws(() => thresholdsFrom({ VISUAL_PIXEL_THRESHOLD: "abc" }), /from 0 to 1/);
});

test("changed and error fail the run; new, updated and same do not", () => {
  const s = summarize([{ status: "same" }, { status: "new" }, { status: "updated" }]);
  assert.equal(s.exitCode, 0);
  assert.equal(s.failing, 0);
  assert.equal(summarize([{ status: "same" }, { status: "changed" }]).exitCode, 1);
  assert.equal(summarize([{ status: "error" }]).exitCode, 1);
  assert.deepEqual(summarize([{ status: "new" }, { status: "new" }, { status: "changed" }]).counts,
    { changed: 1, error: 0, new: 2, updated: 0, same: 0 });
});

test("fonts that did not load fail the run even with nothing changed", () => {
  assert.equal(summarize([{ status: "same" }], { fontsOk: false }).exitCode, 1);
});

test("the report order puts problems first", () => {
  const sorted = sortForReport([
    { name: "b", status: "same" }, { name: "a", status: "new" }, { name: "c", status: "changed" }, { name: "d", status: "error" },
  ]);
  assert.deepEqual(sorted.map((r) => r.status), ["changed", "error", "new", "same"]);
});

test("formatPercent", () => {
  assert.equal(formatPercent(0), "0%");
  assert.equal(formatPercent(0.0123), "1.23%");
  assert.equal(formatPercent(0.001), "0.1%");
  assert.equal(formatPercent(0.00004), "0.004%");
});
