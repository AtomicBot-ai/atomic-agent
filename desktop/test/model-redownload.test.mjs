// ATO-1745: "Download model again" deletes a damaged model's weights first,
// since the agent's downloader skips a file that exists
// (src/local-llm/downloads/model-installer.ts downloadModel). Against the built output.
// Run: npm run build && node --test desktop/test/model-redownload.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { removeDamagedWeights, isWeightsFile } = require("../out/main/model-redownload.js");

function modelsDir(files) {
  const root = mkdtempSync(join(tmpdir(), "redownload-"));
  mkdirSync(join(root, "qwen-3.5-4b"));
  for (const f of files) writeFileSync(join(root, "qwen-3.5-4b", f), "x");
  return root;
}

test("the damaged weights go, the projector stays, so the next pull downloads them again", () => {
  const root = modelsDir(["Qwen3.5-4B-Q4_K_M.gguf", "mmproj-Qwen3.5-4B-F16.gguf", "Qwen3.5-4B-Q4_K_M.gguf.part", "Qwen3.5-4B-Q4_K_M.gguf.part.json"]);
  assert.deepEqual(removeDamagedWeights(root, "qwen-3.5-4b"), []);
  assert.deepEqual(readdirSync(join(root, "qwen-3.5-4b")), ["mmproj-Qwen3.5-4B-F16.gguf"]);
});

test("an id that is not one folder name, or a folder that is not there, deletes nothing", () => {
  const root = modelsDir(["m.gguf"]);
  assert.deepEqual(removeDamagedWeights(root, "../qwen-3.5-4b"), []);
  assert.deepEqual(removeDamagedWeights(root, ".."), []);
  assert.deepEqual(removeDamagedWeights(root, ""), []);
  assert.deepEqual(removeDamagedWeights(root, "not-downloaded"), []);
  assert.ok(existsSync(join(root, "qwen-3.5-4b", "m.gguf")));
});

test("only weights count: a projector or any other file in the folder is not one", () => {
  assert.equal(isWeightsFile("model-Q4_K_M.gguf"), true);
  assert.equal(isWeightsFile("model-Q4_K_M.gguf.part"), true);
  assert.equal(isWeightsFile("mmproj-model-F16.gguf"), false);
  assert.equal(isWeightsFile("mmproj-model-F16.gguf.part"), false);
  assert.equal(isWeightsFile("README.md"), false);
});

test("weights are deleted only while the card says THIS model's file is damaged", () => {
  const { mayDeleteWeights, managedModelIdIn } = require("../out/main/model-redownload.js");
  const corrupt = { reason: "model_file_corrupt", modelId: "qwen-3.5-4b" };
  assert.equal(mayDeleteWeights(corrupt, "qwen-3.5-4b"), true);
  // A stale card about another model, after the config moved on: nothing is deleted.
  assert.equal(mayDeleteWeights(corrupt, "gemma-4-e4b"), false);
  // Any other reason, a card with no model, or no card at all: nothing is deleted.
  for (const reason of ["load", "model_file_missing", "model_unsupported"]) {
    assert.equal(mayDeleteWeights({ reason, modelId: "qwen-3.5-4b" }, "qwen-3.5-4b"), false, reason);
  }
  assert.equal(mayDeleteWeights({ reason: "model_file_corrupt", modelId: null }, "qwen-3.5-4b"), false);
  assert.equal(mayDeleteWeights(null, "qwen-3.5-4b"), false);
  assert.equal(managedModelIdIn({ localModels: { managed: { modelId: "qwen-3.5-4b" } } }), "qwen-3.5-4b");
  assert.equal(managedModelIdIn({ localModels: { managed: { modelId: null } } }), null);
  assert.equal(managedModelIdIn(null), null);
});
