// ATO-923: the slash command list is not drawn while the palette, a menu,
// a model picker, Settings or a question is up. slashShown runs in a vm.
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
const shown = (S, SEL = { open: false }) => {
  const c = vm.createContext({ S, SEL });
  vm.runInContext(fn("slashShown") + "globalThis.r = slashShown();", c);
  return c.r;
};

test("drawn while typing a command with nothing over the composer", () => {
  assert.equal(shown({ slash: true, overlay: null, settings: null, alert: null }), true);
  assert.equal(shown({ slash: false, overlay: null }), false);
});

test("not drawn under the palette, a picker, Settings or a question", () => {
  assert.equal(shown({ slash: true, overlay: "palette" }), false);
  assert.equal(shown({ slash: true, overlay: null }, { open: true }), false);
  assert.equal(shown({ slash: true, overlay: null, settings: 1 }), false);
  assert.equal(shown({ slash: true, overlay: null, alert: { title: "x" } }), false);
});

test("both paint paths and the keys go through it", () => {
  assert.match(source, /\(slashShown\(\) \? slashPopover\(\) : ''\)/);
  assert.match(fn("refreshSlash"), /if \(!slashShown\(\)\) \{ refreshSend\(\); return; \}/);
  assert.match(source, /if \(slashShown\(\) && e\.target\.id === 'entry'/);
});
