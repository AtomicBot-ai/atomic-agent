// ATO-1410: the desktop's vendored catalogue (main/model-catalog.ts) and its
// copy of the naming and memory rules (main/model-memory-words.ts) against the
// agent's own files in this checkout. The smoke's drift check compared ids
// only, so a renamed model or a changed RAM figure reached people as two
// different answers from the terminal and this window. Here every field the
// desktop shows is compared, and the rules are run side by side.
//
// Built output for the desktop side (npm run build first); the agent side is
// read from ../../src and transpiled, no agent build needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const { CURATED_MODEL_META } = require("../out/main/model-catalog.js");
const desktopWords = require("../out/main/model-memory-words.js");

const AGENT_CATALOG = new URL("../../src/local-llm/catalog/models-catalog.ts", import.meta.url);
const AGENT_WORDS = new URL("../../src/local-llm/catalog/model-memory-words.ts", import.meta.url);
const DESKTOP_WORDS = new URL("../main/model-memory-words.ts", import.meta.url);

/** An agent module with no imports, transpiled and run as CommonJS. */
function loadAgent(url) {
  const { outputText } = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    require: (s) => assert.fail(`unexpected agent dependency: ${s}`),
  }, { filename: url.pathname });
  return exports;
}

/** Values from the vm realm, rebuilt here so strict deep equality compares content, not realms. */
const plain = (v) => JSON.parse(JSON.stringify(v));

const agent = loadAgent(AGENT_CATALOG);
const agentWords = loadAgent(AGENT_WORDS);
const AGENT_BY_ID = new Map(agent.LOCAL_MODELS_CATALOG.map((d) => [d.id, d]));

test("the vendored table lists exactly the agent's curated chat models", () => {
  assert.deepEqual(
    CURATED_MODEL_META.map((m) => m.id).sort(),
    plain(agent.LOCAL_MODELS_CATALOG.map((d) => d.id)).sort(),
  );
});

test("every vendored row says what the agent's catalogue says: name, memory, size, blurb", () => {
  for (const m of CURATED_MODEL_META) {
    const d = AGENT_BY_ID.get(m.id);
    assert.ok(d, m.id);
    const want = {
      name: d.name,
      description: d.description,
      minRamGb: d.minRamGb,
      recommendedRamGb: d.recommendedRamGb,
      sizeGb: d.fileSizeGb,
      contextLabel: d.contextLabel,
      mmprojSizeGb: d.mmprojFileSizeGb,
      vision: d.supportsVision === true,
      recommendRank: d.recommendRank,
      tag: d.tag,
      uncensored: d.uncensored === true ? true : undefined,
      spotlight: d.spotlight === true ? true : undefined,
    };
    const got = {
      name: m.name,
      description: m.description,
      minRamGb: m.minRamGb,
      recommendedRamGb: m.recommendedRamGb,
      sizeGb: m.sizeGb,
      contextLabel: m.contextLabel,
      mmprojSizeGb: m.mmprojSizeGb,
      vision: m.vision,
      recommendRank: m.recommendRank,
      tag: m.tag,
      uncensored: m.uncensored === true ? true : undefined,
      spotlight: m.spotlight === true ? true : undefined,
    };
    assert.deepEqual(got, want, `${m.id}: copy the row across from src/local-llm/catalog/models-catalog.ts`);
  }
});

test("the naming and memory rules are one file in two places", () => {
  assert.equal(
    readFileSync(DESKTOP_WORDS, "utf8"),
    readFileSync(AGENT_WORDS, "utf8"),
    "desktop/main/model-memory-words.ts must be a byte-for-byte copy of src/local-llm/catalog/model-memory-words.ts",
  );
});

test("both clients name a model and state its memory need the same way", () => {
  for (const d of agent.LOCAL_MODELS_CATALOG) {
    const m = CURATED_MODEL_META.find((x) => x.id === d.id);
    assert.equal(desktopWords.modelDisplayName(m), agentWords.modelDisplayName(d), d.id);
    assert.equal(desktopWords.modelMemoryNeedGb(m), agentWords.modelMemoryNeedGb(d), d.id);
    assert.equal(desktopWords.modelMemoryNeedWords(m), agentWords.modelMemoryNeedWords(d), d.id);
    for (const ram of [4, 8, 12, 16, 18, 24, 32, 36, 48, 64]) {
      assert.equal(desktopWords.modelMemoryFit(m, ram), agentWords.modelMemoryFit(d, ram), `${d.id} on ${ram} GB`);
    }
  }
});

const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
function fn(name) {
  const at = renderer.indexOf("\nfunction " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return renderer.slice(at + 1, renderer.indexOf("\n}\n", at) + 2);
}

test("an added model gets one size estimate in the agent, desktop main and the renderer", () => {
  const c = vm.createContext({});
  vm.runInContext(fn("ramEstimateFromSize"), c);
  for (const gb of [0.08, 0.5, 1.34, 2.4, 4.22, 6.72, 9.9, 15.9, 22.4, 40, 71.3]) {
    const want = plain(agentWords.estimateRamGbFromFileSize(gb));
    assert.deepEqual(plain(desktopWords.estimateRamGbFromFileSize(gb)), want, `main, ${gb} GB`);
    assert.deepEqual(plain(c.ramEstimateFromSize(gb)), want, `renderer, ${gb} GB`);
  }
});

test("the renderer's model name is the shared display name", () => {
  const c = vm.createContext({ modelWord: (id) => id });
  vm.runInContext(fn("llmModelName"), c);
  for (const m of CURATED_MODEL_META) {
    assert.equal(c.llmModelName(m), agentWords.modelDisplayName(m), m.id);
  }
});

test("a renderer row that will not run says the same need as the terminal", () => {
  assert.ok(!/'Needs ' \+ model\.minRamGb/.test(renderer), "no bare 'Needs <min> GB' left");
  assert.ok(renderer.includes("'Needs ' + model.recommendedRamGb + ' GB'"));
});
