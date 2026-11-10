// ATO-1401: LM Studio typed into Settings › Custom server was offered "as a
// cloud provider", and the person, who wanted it as a local worker for
// Fusion, stopped there. LM Studio, Ollama and Atomic Chat are apps on this
// computer: the prompt names the app, says "local app", and one click adds it.
//
// renderer.js is read as text; llmSteerPresetId runs in a vm context. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const engines = readFileSync(new URL("../renderer/composer-engines.js", import.meta.url), "utf8");

function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

function presetOf(url) {
  const c = vm.createContext({ URL });
  for (const name of ["llmLooksLikeOllama", "llmSteerPresetId"]) vm.runInContext(fn(name), c);
  return c.llmSteerPresetId(url);
}

test("the custom server field knows LM Studio, Ollama and Atomic Chat by their ports", () => {
  assert.equal(presetOf("http://127.0.0.1:1234"), "lmstudio");
  assert.equal(presetOf("http://localhost:1234/v1"), "lmstudio");
  assert.equal(presetOf("http://127.0.0.1:11434"), "ollama");
  assert.equal(presetOf("http://127.0.0.1:1337"), "atomic-chat");
  assert.equal(presetOf("http://127.0.0.1:8080"), null);
});

test("the prompt for an OpenAI-compatible server never says cloud", () => {
  const at = source.indexOf("if (LLMP.steerUrl !== null) {");
  assert.ok(at >= 0);
  const plate = source.slice(at, source.indexOf("\n  return '';\n}", at));
  assert.doesNotMatch(plate, /cloud provider/i);
  assert.match(plate, /Add it as a local app\?/);
});

test("a Fusion seat on a local app is labelled as on this computer, not Cloud provider", () => {
  assert.match(engines, /llmKeylessLocal\(p\) \? 'An app on this computer'/);
});
