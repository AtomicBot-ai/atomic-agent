// ATO-858: when the GPU build cannot load the model, the agent switches to the
// CPU build and saves `localModels.managed.backendVariant: "cpu"` for good.
// Later starts run on the CPU build without printing the switch, so main's
// engine:cpuFallback goes back to null and Settings › Models dropped the line
// "Switched to the CPU build" while the model was still on the CPU. The line
// now also follows the saved setting.
//
// renderer.js is read as text; cpufbSaved and cpufbCardHTML run in a vm
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
  return source.slice(at + 1, source.indexOf("\n", at + 1) + 1);
}

function card({ config = null, on = null, failure = null } = {}) {
  const c = vm.createContext({
    LIVE_CONFIG: config,
    CPUFB: { on, said: 0 },
    ENGF: { f: failure },
    esc: (s) => String(s),
    ic: (name) => "<i:" + name + ">",
  });
  vm.runInContext(constLine("CPUFB_LINE").replace(/^const /, "var "), c);
  for (const name of ["cpufbSaved", "cpufbCardHTML"]) vm.runInContext(fn(name), c);
  return c.cpufbCardHTML();
}
const managed = (backendVariant) => ({ localModels: { mode: "managed", managed: { modelId: "m", backendVariant } } });
const LINE = "Switched to the CPU build";

test("a later start on the saved CPU build still shows the line", () => {
  assert.ok(card({ config: managed("cpu") }).includes(LINE));
});

test("the start that switched shows it, as before", () => {
  assert.ok(card({ config: managed("auto"), on: { at: 1 } }).includes(LINE));
  assert.ok(card({ on: { at: 1 } }).includes(LINE), "no config read yet");
});

test("no line without the switch or the saved CPU build", () => {
  assert.equal(card({ config: managed("auto") }), "");
  assert.equal(card({ config: managed("vulkan") }), "");
  assert.equal(card({ config: { localModels: { mode: "external", managed: { backendVariant: "cpu" } } } }), "");
  assert.equal(card({ config: { localModels: { mode: "managed" } } }), "");
  assert.equal(card(), "");
});

test("the failure card carries it instead", () => {
  assert.equal(card({ config: managed("cpu"), failure: { why: "x", at: 1 } }), "");
});
