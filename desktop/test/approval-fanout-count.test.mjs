// ATO-1355: the fan-out approval card asked "Allow Atomic Agent to hand work
// to its workers?" and the task count ("2 tasks to 2 workers on …") was only
// under Details: the agent's reason starts with a digit, so apprAsk fell back
// to the generic line. The count is now on the face of the card.
//
// renderer.js is read as text; the functions under test run in a vm
// context. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");

function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  const eol = source.indexOf("\n", at + 1);
  const head = source.slice(at + 1, eol);
  if (head.trimEnd().endsWith("}")) return head + "\n";   // a one-line function
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}
function constLine(name) {
  const at = source.indexOf("\nconst " + name + " = ");
  assert.ok(at >= 0, name + " is a top-level const in renderer.js");
  return source.slice(at + 1, source.indexOf("\n", at + 1) + 1);
}
function constBlock(name) {
  const at = source.indexOf("\nconst " + name + " = {");
  assert.ok(at >= 0, name + " is a top-level const in renderer.js");
  return source.slice(at + 1, source.indexOf("\n};", at) + 3);
}

function context() {
  const c = vm.createContext({});
  vm.runInContext(constLine("esc").replace(/^const /, "var "), c);
  vm.runInContext(constBlock("APPR_FALLBACK").replace(/^const /, "var "), c);
  for (const name of ["plural", "clipWords", "moreLines", "moreLinesNote", "apprCode", "apprAsk"]) {
    vm.runInContext(fn(name), c);
  }
  return c;
}

const fanout = (reason) => ({ cat: "fusion_fanout", tool: "fusion.delegate", reason, preview: "(no preview)" });

test("the fan-out card names how many tasks it hands out", () => {
  const c = context();
  assert.equal(c.apprAsk(fanout("2 tasks to 2 workers on qwen3-8b")), "Allow Atomic Agent to hand 2 tasks to its workers?");
  assert.equal(c.apprAsk(fanout("5 tasks to 3 workers on qwen3-8b (local)")), "Allow Atomic Agent to hand 5 tasks to its workers?");
});

test("one task is singular", () => {
  const c = context();
  assert.equal(c.apprAsk(fanout("1 task to 1 worker on qwen3-8b")), "Allow Atomic Agent to hand 1 task to its workers?");
});

test("a fan-out reason in another shape keeps the generic line", () => {
  const c = context();
  assert.equal(c.apprAsk(fanout("")), "Allow Atomic Agent to hand work to its workers?");
  assert.equal(c.apprAsk(fanout("12 of something else")), "Allow Atomic Agent to hand work to its workers?");
});
