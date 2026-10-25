// ATO-817: the one model the desktop points at used to be the biggest that
// runs comfortably, so a 32 GB Mac was sent to a less common 30B. Within a
// fit band the catalogue's recommendation order (`recommendRank`, the same
// rule as the agent's recommendedModelFor) now comes first.
//
// renderer.js is read as text; the fit helpers run in a vm context.
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
function constBlock(name) {
  const at = source.indexOf("\nconst " + name + " =");
  assert.ok(at >= 0, name + " is a top-level const in renderer.js");
  return source.slice(at + 1, source.indexOf(";\n", at) + 2).replace(/^const /, "var ");
}

const c = vm.createContext({});
vm.runInContext(constBlock("TIGHT_FIT_CAUTION"), c);
for (const name of ["sizeStringGb", "fitFor", "orderModelsByFit", "bestModelFor"]) vm.runInContext(fn(name), c);

// Figures from the vendored catalogue (desktop/main/model-catalog.ts).
const models = [
  { id: "nemotron-3.5-30b-a3b", minRamGb: 24, recommendedRamGb: 32, size: "19.7 GB" },
  { id: "qwen-3.8-27b", minRamGb: 20, recommendedRamGb: 28, size: "17.9 GB", recommendRank: 1 },
  { id: "gemma-4-31b", minRamGb: 20, recommendedRamGb: 24, size: "17.3 GB", recommendRank: 4 },
  { id: "qwen-3.5-9b", minRamGb: 10, recommendedRamGb: 16, size: "5.3 GB", recommendRank: 7 },
  { id: "qwen-3.5-4b", minRamGb: 6, recommendedRamGb: 8, size: "2.7 GB", recommendRank: 9 },
  { id: "gemma-4-e4b", minRamGb: 6, recommendedRamGb: 8, size: "4.2 GB", recommendRank: 10 },
  { id: "qwen-3.8-27b-uncensored", minRamGb: 20, recommendedRamGb: 32, size: "16.5 GB", uncensored: true },
];

test("the best-ranked model that runs comfortably wins, not the biggest", () => {
  assert.equal(c.bestModelFor(models, 8).id, "qwen-3.5-4b");
  assert.equal(c.bestModelFor(models, 16).id, "qwen-3.5-9b");
  assert.equal(c.bestModelFor(models, 32).id, "qwen-3.8-27b");
  assert.equal(c.bestModelFor(models, 64).id, "qwen-3.8-27b");
});

test("the recommendation is the first row of the fit order, so the default pick agrees", () => {
  for (const ram of [8, 16, 32, 64]) {
    assert.equal(c.orderModelsByFit(models, ram)[0].id, c.bestModelFor(models, ram).id);
  }
});

test("unranked models keep the old largest-first order after the ranked ones", () => {
  const plain = [
    { id: "a", minRamGb: 4, recommendedRamGb: 6, size: "2 GB" },
    { id: "b", minRamGb: 8, recommendedRamGb: 12, size: "7 GB" },
  ];
  assert.equal(c.bestModelFor(plain, 32).id, "b");
  const order = c.orderModelsByFit(models, 64).map((m) => m.id);
  assert.ok(order.indexOf("nemotron-3.5-30b-a3b") > order.indexOf("gemma-4-e4b"), order.join(", "));
});
