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
  // A port on another machine is not an app on this one.
  assert.equal(presetOf("http://192.168.1.20:1234"), null);
  assert.equal(presetOf("http://192.168.1.20:11434"), null);
  assert.equal(presetOf("http://192.168.1.20:1337"), null);
});

test("the prompt for an OpenAI-compatible server never says cloud", () => {
  const at = source.indexOf("if (LLMP.steerUrl !== null) {");
  assert.ok(at >= 0);
  const plate = source.slice(at, source.indexOf("\n  return '';\n}", at));
  assert.doesNotMatch(plate, /cloud provider/i);
  assert.match(plate, /Add it as a local app\?/);
});

// The Fusion seat picker's rows, built for real in a vm with one ready
// Ollama on this computer, one on a LAN box, and one cloud provider.
function fusionRows() {
  const c = vm.createContext({
    URL,
    rmNow: () => ({ workerProviderId: "ollama", orchestratorProviderId: "openrouter" }),
    selProviders: () => [
      { id: "ollama", kind: "openai-compatible", baseUrl: "http://127.0.0.1:11434" },
      { id: "lan-ollama", kind: "openai-compatible", baseUrl: "http://192.168.1.20:11434" },
      { id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
    ],
    BSW: { readyIds: ["ollama", "lan-ollama", "openrouter"] },
    savedKeyInvalid: () => false,
    llmManaged: () => ({}),
  });
  vm.runInContext(engines + "\nthis.rows = composerFusionEngineRows;", c);
  const detail = (id) => (c.rows("worker").find((r) => r.id === id) || {}).detail;
  return { detail };
}

test("a Fusion seat on a local app reads as on this computer, never Cloud provider", () => {
  const { detail } = fusionRows();
  assert.equal(detail("ollama"), "An app on this computer");
  assert.equal(detail("lan-ollama"), "Cloud provider");
  assert.equal(detail("openrouter"), "Cloud provider");
});
