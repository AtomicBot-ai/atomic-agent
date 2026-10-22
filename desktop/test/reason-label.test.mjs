// ATO-467 / ATO-820: the reasoning row says "Thought for N s". A model that
// thinks again in the same row after its reply began used to keep only the
// first span, so the label was too low. Every span now counts.
//
// renderer.js is read as text; reasonLabel, reasonReopen and dur run in a vm
// context. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");

function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}
function constLine(name) {
  const at = source.indexOf("\nconst " + name + " = ");
  assert.ok(at >= 0, name + " is a top-level const in renderer.js");
  return source.slice(at + 1, source.indexOf("\n};\n", at) + 3);
}

function context() {
  const c = vm.createContext({});
  vm.runInContext(constLine("dur").replace(/^const /, "var "), c);
  for (const name of ["reasonLabel", "reasonReopen"]) vm.runInContext(fn(name), c);
  return c;
}

test("a row still thinking, or timed under a second, says Reasoning", () => {
  const c = context();
  assert.equal(c.reasonLabel({ startedAt: 1000, endedAt: null }), "Reasoning");
  assert.equal(c.reasonLabel({ startedAt: 1000, endedAt: 1500 }), "Reasoning");
  assert.equal(c.reasonLabel({}), "Reasoning");
});

test("one span is timed from its first frame to the next frame of another kind", () => {
  const c = context();
  assert.equal(c.reasonLabel({ startedAt: 1000, endedAt: 4000 }), "Thought for 3.0 s");
});

test("thinking again in the same row adds the new span to the first one", () => {
  const c = context();
  const row = { startedAt: 1000, endedAt: 4000 };          // 3 s, then a reply word
  c.reasonReopen(row, 10_000);                            // more thinking after the reply began
  assert.equal(row.endedAt, null);
  assert.equal(c.reasonLabel(row), "Reasoning", "still thinking: no total yet");
  row.endedAt = 15_000;                                   // 5 s more
  assert.equal(c.reasonLabel(row), "Thought for 8.0 s");
});

test("reopening a row that is still thinking changes nothing", () => {
  const c = context();
  const row = { startedAt: 1000, endedAt: null };
  c.reasonReopen(row, 2000);
  assert.deepEqual({ ...row }, { startedAt: 1000, endedAt: null });
});
