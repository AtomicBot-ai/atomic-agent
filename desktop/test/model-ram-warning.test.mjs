// ATO-337: a model this machine is under the catalogue's minimum for used to
// be marked "will not run" and then downloaded and started without a word.
// Settings › LLM and the composer's picker now warn first, with the memory
// it needs, the memory here, and a model that does run here.
//
// renderer.js is read as text; modelRamWarning and the fit helpers it uses
// run in a vm context. No deps, no build.
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

const c = vm.createContext({
  THIS_MACHINE_CAP: "This Mac",
  llmModelName: (m) => m.name,
});
vm.runInContext(constBlock("TIGHT_FIT_CAUTION"), c);
for (const name of ["sizeStringGb", "fitFor", "orderModelsByFit", "bestModelFor", "modelRamWarning"]) vm.runInContext(fn(name), c);

const big = { id: "big-70b", name: "Big 70B", minRamGb: 48, recommendedRamGb: 64, size: "40 GB" };
const qwen = { id: "qwen-3.8-27b", name: "Qwen 3.8 27B", minRamGb: 20, recommendedRamGb: 32, size: "17 GB" };
const small = { id: "small-4b", name: "Small 4B", minRamGb: 6, recommendedRamGb: 8, size: "3 GB" };
const models = [big, qwen, small];

test("a model over this Mac's memory names what it needs, what is here, and one that runs", () => {
  const w = c.modelRamWarning(big, models, 32);
  assert.equal(w.title, "Not enough memory for this model");
  assert.equal(w.text, "This model needs 48 GB of memory. This Mac has 32 GB. Qwen 3.8 27B runs here.");
  assert.equal(w.alt.id, "qwen-3.8-27b");
  assert.ok(!/—/.test(w.title + w.text));
});

test("no warning for a model that runs, even a tight fit", () => {
  assert.equal(c.modelRamWarning(qwen, models, 32), null);
  assert.equal(c.modelRamWarning(qwen, models, 24), null);
});

test("no suggestion when nothing else runs here", () => {
  const w = c.modelRamWarning(big, [big], 32);
  assert.equal(w.text, "This model needs 48 GB of memory. This Mac has 32 GB.");
  assert.equal(w.alt, null);
});

test("nothing is said without firm figures: unknown RAM, or a model the catalogue does not describe", () => {
  assert.equal(c.modelRamWarning(big, models, 0), null);
  assert.equal(c.modelRamWarning({ id: "custom-x", name: "X", size: "60 GB" }, models, 16), null);
  assert.equal(c.modelRamWarning(null, models, 32), null);
});
