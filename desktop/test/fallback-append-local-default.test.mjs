// ATO-1643: since v0.7.0 the agent does not append the local model to the
// fallback chain unless llm.fallback.appendLocal is true (DEFAULT_APPEND_LOCAL
// = false in src/llm/fallback/fallback-config.ts). The desktop used to read an
// unset value as on: Settings › Fallback showed "On" with the local model in
// the chain, and the turn gate promised a fallback the agent never runs.
//
// renderer.js is read as text; llmFallbackView runs in a vm context with its
// neighbours stubbed. No deps, no build.
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

const providers = [
  { id: "openrouter", kind: "openrouter", model: "m1" },
  { id: "local-llama", kind: "llama-server", model: "q" },
];

function viewFor(fallback) {
  const llm = { activeTextProvider: "openrouter", providers };
  if (fallback !== undefined) llm.fallback = fallback;
  const c = vm.createContext({
    llmBlock: () => llm,
    llmProviders: () => providers,
    llmActiveTextId: () => "openrouter",
  });
  vm.runInContext(fn("llmFallbackView") + "globalThis.llmFallbackView = llmFallbackView;", c);
  return c.llmFallbackView();
}

test("no llm.fallback block: local is Off and not in the chain", () => {
  const v = viewFor(undefined);
  assert.equal(v.appendLocal, false);
  assert.deepEqual(Array.from(v.links, (l) => l.providerId), ["openrouter"]);
  assert.ok(v.addableProviderIds.includes("local-llama"));
});

test("fallback block without appendLocal: still Off", () => {
  const v = viewFor({ chain: ["openrouter"] });
  assert.equal(v.appendLocal, false);
  assert.ok(!v.links.some((l) => l.isAppendedLocal));
});

test("appendLocal true: On, local appended last", () => {
  const v = viewFor({ appendLocal: true });
  assert.equal(v.appendLocal, true);
  assert.deepEqual(Array.from(v.links, (l) => l.providerId), ["openrouter", "local-llama"]);
  assert.equal(v.links[1].isAppendedLocal, true);
});

test("appendLocal false: Off", () => {
  assert.equal(viewFor({ appendLocal: false }).appendLocal, false);
});

test("turn gate appends local only when appendLocal is true", () => {
  const gate = fn("localTurnGate");
  assert.ok(gate.includes("fb.appendLocal === true"), "localTurnGate treats unset as off");
  assert.ok(!gate.includes("fb.appendLocal !== false"), "the old unset-means-on check is gone");
});
