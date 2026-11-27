// Unit tests for test/visual/report.mjs and the pure parts of screens.mjs /
// stabilize.mjs (ATO-2761). Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";

import { esc, renderReport } from "./visual/report.mjs";
import { hooksNeeded, partitionByHooks, SCREENS } from "./visual/screens.mjs";
import { scrubVersions } from "./visual/stabilize.mjs";

const V = { width: 1470, height: 923, scale: 1 };
const META = { platform: "darwin-arm64", when: "2026-11-27T12:00:00.000Z", mode: "compare",
  thresholds: { pixelThreshold: 0.1, maxDiffRatio: 0.001 }, fonts: { ok: true, detail: "" }, dropped: [], unknownScreens: [] };

const results = [
  { name: "chat-empty--light--1470x923-1x", screen: "chat-empty", theme: "light", variant: V, status: "same", reason: "identical", ratio: 0,
    images: { baseline: "baseline/chat-empty--light--1470x923-1x.png", actual: "actual/chat-empty--light--1470x923-1x.png" } },
  { name: "settings-general--dark--1470x923-1x", screen: "settings-general", theme: "dark", variant: V, status: "changed", reason: "2% of the pixels differ", ratio: 0.02,
    images: { baseline: "baseline/settings-general--dark--1470x923-1x.png", actual: "actual/settings-general--dark--1470x923-1x.png", diff: "diff/settings-general--dark--1470x923-1x.png" } },
  { name: "model-picker--light--1470x923-1x", screen: "model-picker", theme: "light", variant: V, status: "new", reason: "no baseline yet", ratio: null,
    images: { actual: "actual/model-picker--light--1470x923-1x.png" } },
];

test("the summary counts sit at the top, before any shot", () => {
  const html = renderReport(results, META);
  const counts = html.indexOf('class="counts"');
  assert.ok(counts > 0);
  assert.ok(counts < html.indexOf('class="shot'));
  assert.match(html, /<b>1<\/b> Changed/);
  assert.match(html, /<b>1<\/b> New \(no baseline\)/);
  assert.match(html, /<b>1<\/b> Unchanged/);
  assert.match(html, /1 shot\(s\) changed or could not be shot/);
});

test("each shot has before, after and difference, with relative paths", () => {
  const html = renderReport(results, META);
  assert.match(html, /src="baseline\/settings-general--dark--1470x923-1x\.png"/);
  assert.match(html, /src="actual\/settings-general--dark--1470x923-1x\.png"/);
  assert.match(html, /src="diff\/settings-general--dark--1470x923-1x\.png"/);
  assert.doesNotMatch(html, /src="\//, "no absolute paths: the folder is zipped as a CI artifact");
});

test("changed shots come first in the page", () => {
  const html = renderReport(results, META);
  assert.ok(html.indexOf('id="settings-general--dark') < html.indexOf('id="chat-empty--light'));
});

test("a run with nothing over the limit says so", () => {
  const html = renderReport([results[0], results[2]], META);
  assert.match(html, /Nothing over the limit/);
});

test("dropped screens, unknown ids and missing fonts are listed", () => {
  const html = renderReport([], { ...META, fonts: { ok: false, detail: "Figtree false" },
    dropped: [{ id: "download-card", label: "Download card", reason: "hook not in this build: window.__dlSeed" }],
    unknownScreens: ["nope"] });
  assert.match(html, /Screens left out/);
  assert.match(html, /window\.__dlSeed/);
  assert.match(html, /"nope"/);
  assert.match(html, /vendored fonts did not load/);
  assert.match(html, /No shots were taken/);
});

test("text is escaped", () => {
  assert.equal(esc(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  const html = renderReport([{ ...results[1], error: "<script>alert(1)</script>", status: "error" }], META);
  assert.doesNotMatch(html, /<script>/);
});

test("screens whose hooks are missing are dropped, with the hook named", () => {
  const present = new Set(hooksNeeded(SCREENS).filter((h) => h !== "__dlSeed"));
  const { runnable, dropped } = partitionByHooks(SCREENS, present);
  assert.deepEqual(dropped.map((d) => d.id), ["download-card"]);
  assert.match(dropped[0].reason, /window\.__dlSeed/);
  assert.equal(runnable.length, SCREENS.length - 1);
});

test("the screen list has unique ids and covers the agreed set", () => {
  const ids = SCREENS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const want of ["onboarding-title", "onboarding-setup", "onboarding-providers", "onboarding-api-key", "chat-empty",
    "chat-answer", "slash-menu", "settings-general", "settings-models", "model-picker", "download-card"]) {
    assert.ok(ids.includes(want), want);
  }
  for (const s of SCREENS) assert.equal(typeof s.run, "function", s.id);
});

test("version text is pinned so a version bump is not a visual change", () => {
  assert.equal(scrubVersions("Atomic Agent 0.0.11 (core v0.10.0)"), "Atomic Agent 0.0.0 (core v0.0.0)");
  assert.equal(scrubVersions("build 1.2.3-beta.4"), "build 0.0.0");
  assert.equal(scrubVersions("qwen3.5-4b and 4.5 GB"), "qwen3.5-4b and 4.5 GB");
});
