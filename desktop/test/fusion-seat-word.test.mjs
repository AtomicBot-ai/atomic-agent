// ATO-1540: renderer.js declared `fzSeatWord` twice. The second one (a
// provider id -> its name) replaced the first (a seat's model -> its chip
// word), so the Fusion seat chips showed provider names instead of models.
// The provider version is now `fzProviderWord`.
//
// renderer.js is read as text; no deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");

function fnText(name) {
  const at = renderer.indexOf("\nfunction " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return renderer.slice(at + 1, renderer.indexOf("\n}\n", at) + 3);
}

test("no top-level function in renderer.js is declared twice", () => {
  const names = [...renderer.matchAll(/^(?:async )?function ([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]);
  const seen = new Set();
  const twice = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
  assert.deepEqual(twice, []);
});

const c = vm.createContext({
  SEL: { local: [{ id: "gemma-4-e4b-qat", name: "Gemma 4 E4B QAT GGUF" }] },
  composerEngineName: () => "Local models",
  providerWord: (id) => ({ openrouter: "OpenRouter" })[id] || id,
});
vm.runInContext(
  "var shortModel = (id) => id.replace(/-instruct$/, '');\n"
    + ["modelWord", "fzSeatWord", "fzSeatId", "fzProviderWord"].map(fnText).join("\n"),
  c,
);

test("a seat chip names its model: catalogue name for a local model, id without the vendor for a cloud one", () => {
  assert.equal(c.fzSeatWord("gemma-4-e4b-qat"), "Gemma 4 E4B");
  assert.equal(c.fzSeatWord("x-ai/grok-4-6"), "grok-4-6");
  assert.equal(c.fzSeatWord("gpt-5"), "gpt-5");
});

test("a seat's provider is named in words, and nothing when there is no provider", () => {
  assert.equal(c.fzProviderWord("local-llama"), "Local models");
  assert.equal(c.fzProviderWord("openrouter"), "OpenRouter");
  assert.equal(c.fzProviderWord(null), null);
  assert.equal(c.fzProviderWord(""), null);
});

test("the run-mode line and the Fusion intro name providers, the chips name models", () => {
  for (const name of ["rmSettingsLine", "fzIntroParagraphs"]) {
    const body = fnText(name);
    assert.match(body, /fzProviderWord\(/, name);
    assert.doesNotMatch(body, /fzSeatWord\(/, name);
  }
  assert.match(fnText("fzChipsHtml"), /fzSeatWord\(label\)/);
  assert.doesNotMatch(fnText("fzChipsHtml"), /fzProviderWord\(/);
});
