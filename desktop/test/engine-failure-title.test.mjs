// Unit tests for renderer/engine-failure-title.js (ATO-2515).
// Run: npm run test:unit
// A damaged or missing model file, or a model the engine is too old for, is
// the model's trouble, not the engine's: the failure card, strip, toast and
// setup row carry their own title instead of "The local engine isn't ready".
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const T = createRequire(import.meta.url)("../renderer/engine-failure-title.js");
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("a damaged or missing model file says the file needs downloading again", () => {
  for (const reason of ["model_file_corrupt", "model_file_missing"]) {
    assert.equal(T.engfTitleOf({ why: "x", reason }), "The model file needs to be downloaded again", reason);
  }
});

test("a model too new for the engine says so, in the body's own word", () => {
  const why = "This model needs a newer engine. Update Atomic Agent, then start it again.";
  const title = T.engfTitleOf({ why, reason: "model_unsupported" });
  assert.equal(title, "This model needs a newer engine");
  assert.ok(why.includes("newer engine"));
});

test("every engine failure keeps the engine title", () => {
  for (const f of [{ why: "x", stage: "download" }, { why: "x", reason: "load" }, { why: "x", reason: "incomplete" }, { why: "x", reason: "disk" }, null, undefined]) {
    assert.equal(T.engfTitleOf(f), "The local engine isn’t ready");
  }
});

test("the app line names the model for a model reason, the engine otherwise", () => {
  assert.equal(T.engfSayLine({ why: "W", detail: "D", reason: "model_file_corrupt" }), "The model file needs to be downloaded again: D");
  assert.equal(T.engfSayLine({ why: "W", stage: "start" }), "The local engine is not ready: W");
});

test("no title has a long dash", () => {
  for (const s of [T.ENGF_TITLE, T.ENGF_TITLE_MODEL_FILE, T.ENGF_TITLE_UNSUPPORTED]) assert.doesNotMatch(s, /\u2014/);
});

test("renderer.js draws every engine failure title through engfTitleOf, loaded before it", () => {
  const r = src("../renderer/renderer.js");
  assert.doesNotMatch(r, /esc\(ENGF_TITLE\)|toast\(ENGF_TITLE/);
  assert.doesNotMatch(r, /const ENGF_TITLE\b/);
  assert.equal((r.match(/esc\(engfTitleOf\(/g) || []).length, 3);
  assert.match(r, /toast\(engfTitleOf\(ENGF\.f\)/);
  const html = src("../renderer/index.html");
  const at = html.indexOf('<script src="engine-failure-title.js"></script>');
  assert.ok(at > 0 && at < html.indexOf('<script src="renderer.js"></script>'));
});
