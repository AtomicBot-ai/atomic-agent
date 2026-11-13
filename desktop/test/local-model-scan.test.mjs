// "If some model was downloaded before, it should just get picked up."
// The scan for GGUF models already on this computer (main/local-model-scan.ts),
// against a temp-dir fixture. Model files are sparse: 4 bytes of "GGUF" and a
// truncate past the 50 MB floor, so the suite writes almost nothing to disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const M = require("../out/main/local-model-scan.js");

const MB = 1024 * 1024;

function gguf(path, bytes = 60 * MB, magic = "GGUF") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, magic);
  truncateSync(path, bytes);
  return path;
}

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "found-models-"));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
async function fixtureAsync(fn) {
  const root = mkdtempSync(join(tmpdir(), "found-models-"));
  try { return await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("skip rules a name decides: partials, projectors, embeddings, shards past the first", () => {
  assert.equal(M.skipByName("Qwen3-8B-Q4_K_M.gguf"), false);
  assert.equal(M.skipByName("Qwen3-8B-Q4_K_M.gguf.part"), true);
  assert.equal(M.skipByName("Qwen3-8B-Q4_K_M.gguf.download"), true);
  assert.equal(M.skipByName("model.safetensors"), true);
  assert.equal(M.skipByName("mmproj-model-f16.gguf"), true);
  assert.equal(M.skipByName("gemma-3-4b-it-mmproj-F16.gguf"), true);
  assert.equal(M.skipByName("nomic-embed-text-v1.5.Q8_0.gguf"), true);
  assert.equal(M.skipByName("bge-reranker-v2-m3-Q8_0.gguf"), true);
  assert.equal(M.skipByName(".hidden.gguf"), true);
  assert.equal(M.skipByName("big-00001-of-00003.gguf"), false);
  assert.equal(M.skipByName("big-00002-of-00003.gguf"), true);
  assert.equal(M.skipByName("big-00003-of-00003.gguf"), true);
});

test("shards, quantisation and the display name", () => {
  assert.deepEqual(M.shardOf("big-00001-of-00003.gguf"), { base: "big", index: 1, count: 3 });
  assert.equal(M.shardOf("big-00004-of-00003.gguf"), null);
  assert.equal(M.shardOf("plain.gguf"), null);
  assert.equal(M.quantOf("Qwen3-8B-Q4_K_M.gguf"), "Q4_K_M");
  assert.equal(M.quantOf("gemma-3-4b-it-UD-IQ2_XXS.gguf"), "IQ2_XXS");
  assert.equal(M.quantOf("llama-3.2-1b-instruct-q8_0.gguf"), "Q8_0");
  assert.equal(M.quantOf("Qwen3-30B-A3B-BF16-00001-of-00002.gguf"), "BF16");
  assert.equal(M.quantOf("Qwen3-8B.gguf"), undefined);
  assert.equal(M.displayName("/x/Qwen3-8B-Q4_K_M.gguf"), "Qwen3-8B-Q4_K_M");
  assert.equal(M.displayName("/x/big-00001-of-00003.gguf"), "big");
  // Jan keeps every model as <id>/model.gguf: the folder is the name.
  assert.equal(M.displayName("/jan/models/llama3.2-3b-instruct/model.gguf"), "llama3.2-3b-instruct");
});

test("folders: the Hugging Face env rules, LLAMA_CACHE, the default store only when it differs", () => {
  const home = "/Users/q";
  const base = { home, platform: "darwin", env: {}, managedModelsDir: "/s/models/models" };
  assert.equal(M.huggingFaceHubDir({}, home), "/Users/q/.cache/huggingface/hub");
  assert.equal(M.huggingFaceHubDir({ XDG_CACHE_HOME: "/xdg" }, home), "/xdg/huggingface/hub");
  assert.equal(M.huggingFaceHubDir({ HF_HOME: "/hf" }, home), "/hf/hub");
  assert.equal(M.huggingFaceHubDir({ HF_HOME: "/hf", HF_HUB_CACHE: "/hub" }, home), "/hub");
  assert.equal(M.huggingFaceHubDir({ HUGGINGFACE_HUB_CACHE: "/old" }, home), "/old");
  assert.equal(M.huggingFaceHubDir({ HF_HOME: "relative/dir" }, home), "/Users/q/.cache/huggingface/hub");
  assert.equal(M.llamaCppCacheDir({}, home, "darwin"), "/Users/q/Library/Caches/llama.cpp");
  assert.equal(M.llamaCppCacheDir({}, home, "linux"), "/Users/q/.cache/llama.cpp");
  assert.equal(M.llamaCppCacheDir({ LLAMA_CACHE: "/lc" }, home, "darwin"), "/lc");

  const dirs = (i) => M.scanRoots(i).map((r) => `${r.source}:${r.dir}`);
  const plain = dirs(base);
  assert.equal(plain[0], "atomic:/s/models/models");
  assert.equal(plain.filter((d) => d.startsWith("atomic:")).length, 1);
  assert.ok(plain.includes("lmstudio:/Users/q/.lmstudio/models"));
  assert.ok(plain.includes("lmstudio:/Users/q/.cache/lm-studio/models"));
  assert.ok(plain.includes("huggingface:/Users/q/.cache/huggingface/hub"));
  assert.ok(plain.includes("jan:/Users/q/jan/models"));
  assert.ok(plain.includes("jan:/Users/q/Library/Application Support/Jan/data/llamacpp/models"));
  assert.ok(plain.includes("llamacpp:/Users/q/Library/Caches/llama.cpp"));
  assert.equal(dirs({ ...base, defaultModelsDir: "/s/models/models" }).filter((d) => d.startsWith("atomic:")).length, 1);
  const qa = dirs({ ...base, defaultModelsDir: "/Users/q/.atomic-agent/models/models" });
  assert.deepEqual(qa.slice(0, 2), ["atomic:/s/models/models", "atomic:/Users/q/.atomic-agent/models/models"]);
  assert.ok(dirs({ ...base, lmStudioHome: "/Volumes/ext/lms" }).includes("lmstudio:/Volumes/ext/lms/models"));
  assert.ok(dirs({ ...base, env: { HF_HUB_CACHE: "/hub" } }).includes("huggingface:/hub"));
});

test("the fixture: every source, the skip rules, dedupe, and what is registered", () => fixtureAsync(async (root) => {
  const store = join(root, "state", "models", "models");
  const tuiStore = join(root, "home", ".atomic-agent", "models", "models");
  const lms = join(root, "home", ".lmstudio", "models");
  const hub = join(root, "home", ".cache", "huggingface", "hub");
  const jan = join(root, "home", "jan", "models");
  const lcpp = join(root, "home", "Library", "Caches", "llama.cpp");

  // Our store: a catalogue model, an HF-added one with its entry, one whose entry was lost, a partial.
  gguf(join(store, "qwen3-8b", "Qwen3-8B-Q4_K_M.gguf"));
  gguf(join(store, "custom-unsloth-gemma-abc", "gemma-3-4b-it-Q4_K_M.gguf"));
  gguf(join(store, "custom-lost-entry-def", "Mistral-7B-Q5_K_M.gguf"));
  gguf(join(store, "qwen3-14b", "Qwen3-14B-Q4_K_M.gguf"));
  writeFileSync(join(store, "qwen3-14b", "Qwen3-14B-Q4_K_M.gguf.part"), "x");
  gguf(join(store, "nomic-embed", "nomic-embed-text-v1.5.Q8_0.gguf"));
  // The default ~/.atomic-agent store, seen from a clean QA state dir.
  gguf(join(tuiStore, "llama-3.2-3b", "Llama-3.2-3B-Instruct-Q4_K_M.gguf"));
  // LM Studio: a model, its projector, a tiny file, a file without the magic.
  gguf(join(lms, "lmstudio-community", "Qwen3-4B-GGUF", "Qwen3-4B-Q8_0.gguf"));
  gguf(join(lms, "lmstudio-community", "Qwen3-4B-GGUF", "mmproj-Qwen3-4B-F16.gguf"));
  gguf(join(lms, "tiny", "t", "tiny-Q4_0.gguf"), 10 * MB);
  gguf(join(lms, "junk", "j", "notreally-Q4_0.gguf"), 60 * MB, "XXXX");
  // Hugging Face: two revisions linking one blob, and a complete and an incomplete shard set.
  const blobs = join(hub, "models--bartowski--Phi-4-GGUF", "blobs");
  gguf(join(blobs, "aaaa"));
  for (const rev of ["r1", "r2"]) {
    const snap = join(hub, "models--bartowski--Phi-4-GGUF", "snapshots", rev);
    mkdirSync(snap, { recursive: true });
    symlinkSync(join(blobs, "aaaa"), join(snap, "phi-4-Q4_K_M.gguf"));
  }
  const big = join(hub, "models--o--Big-GGUF", "snapshots", "r", "Q4_K_M");
  gguf(join(big, "Big-Q4_K_M-00001-of-00002.gguf"), 40 * MB);
  gguf(join(big, "Big-Q4_K_M-00002-of-00002.gguf"), 40 * MB);
  const half = join(hub, "models--o--Half-GGUF", "snapshots", "r");
  gguf(join(half, "Half-Q4_K_M-00001-of-00003.gguf"));
  gguf(join(half, "Half-Q4_K_M-00002-of-00003.gguf"));
  // Jan and llama.cpp.
  gguf(join(jan, "llama3.2-1b-instruct", "model.gguf"));
  gguf(join(lcpp, "ggml-org_gemma-3-1b-it-GGUF_gemma-3-1b-it-Q4_K_M.gguf"));
  // A file the person added by path earlier.
  const picked = gguf(join(root, "home", "Downloads", "Picked-Q6_K.gguf"));

  const roots = M.scanRoots({
    home: join(root, "home"), platform: "darwin", env: {}, managedModelsDir: store, defaultModelsDir: tuiStore,
  });
  const reg = {
    managedModelsDir: store,
    customModels: [
      { id: "custom-unsloth-gemma-abc", filename: "gemma-3-4b-it-Q4_K_M.gguf", name: "Gemma 3 4B" },
      { id: "custom-local-picked-1234", filename: "Picked-Q6_K.gguf", localPath: picked },
    ],
    isCatalogId: (id) => id === "qwen3-8b" || id === "qwen3-14b",
    catalogName: (id) => (id === "qwen3-8b" ? "Qwen 3 8B" : null),
  };
  const { models, truncated } = await M.scanLocalModels(roots, reg);
  assert.equal(truncated, false);
  const by = Object.fromEntries(models.map((m) => [m.path.slice(root.length + 1), m]));
  const at = (p) => by[p] ?? assert.fail(`not found: ${p}\nfound: ${Object.keys(by).join("\n")}`);

  const cat = at("state/models/models/qwen3-8b/Qwen3-8B-Q4_K_M.gguf");
  assert.equal(cat.registered, true);
  assert.equal(cat.modelId, "qwen3-8b");
  assert.equal(cat.name, "Qwen 3 8B");
  assert.equal(cat.source, "atomic");
  assert.equal(cat.quant, "Q4_K_M");
  assert.equal(at("state/models/models/custom-unsloth-gemma-abc/gemma-3-4b-it-Q4_K_M.gguf").modelId, "custom-unsloth-gemma-abc");
  const lost = at("state/models/models/custom-lost-entry-def/Mistral-7B-Q5_K_M.gguf");
  assert.equal(lost.registered, false);
  assert.equal(lost.orphanInStore, true);
  assert.equal(by["state/models/models/qwen3-14b/Qwen3-14B-Q4_K_M.gguf"], undefined, "a .part beside it: still downloading");
  assert.equal(by["state/models/models/nomic-embed/nomic-embed-text-v1.5.Q8_0.gguf"], undefined);

  const qa = at("home/.atomic-agent/models/models/llama-3.2-3b/Llama-3.2-3B-Instruct-Q4_K_M.gguf");
  assert.equal(qa.source, "atomic");
  assert.equal(qa.registered, false);
  assert.equal(qa.orphanInStore, undefined, "the default store is not this app's store: registered in place");

  assert.equal(at("home/.lmstudio/models/lmstudio-community/Qwen3-4B-GGUF/Qwen3-4B-Q8_0.gguf").source, "lmstudio");
  assert.equal(Object.keys(by).some((p) => /mmproj|tiny|notreally/.test(p)), false);

  const phi = models.filter((m) => m.name === "phi-4-Q4_K_M");
  assert.equal(phi.length, 1, "two snapshots of one blob are one model");
  assert.equal(phi[0].source, "huggingface");
  assert.equal(phi[0].sizeBytes, 60 * MB);
  const bigOne = at("home/.cache/huggingface/hub/models--o--Big-GGUF/snapshots/r/Q4_K_M/Big-Q4_K_M-00001-of-00002.gguf");
  assert.equal(bigOne.sizeBytes, 80 * MB, "a shard set counts all its shards, and passes the floor together");
  assert.equal(bigOne.name, "Big-Q4_K_M");
  assert.equal(Object.keys(by).some((p) => p.includes("Half-GGUF")), false, "a shard set missing a part is skipped");
  assert.equal(Object.keys(by).some((p) => p.includes("00002-of")), false);

  const janOne = at("home/jan/models/llama3.2-1b-instruct/model.gguf");
  assert.equal(janOne.source, "jan");
  assert.equal(janOne.name, "llama3.2-1b-instruct");
  assert.equal(at("home/Library/Caches/llama.cpp/ggml-org_gemma-3-1b-it-GGUF_gemma-3-1b-it-Q4_K_M.gguf").source, "llamacpp");

  // The window's view carries no ids and no store flags.
  const pub = M.publicModels(models);
  assert.deepEqual(Object.keys(pub.find((m) => m.path === cat.path)).sort(), ["name", "path", "quant", "registered", "sizeBytes", "source"]);
}));

test("a localPath entry marks its file registered, also through a symlink", () => fixtureAsync(async (root) => {
  const real = gguf(join(root, "real", "Picked-Q6_K.gguf"));
  symlinkSync(join(root, "real"), join(root, "link"));
  const reg = {
    managedModelsDir: join(root, "store"),
    customModels: [{ id: "custom-local-p-1", localPath: join(root, "link", "Picked-Q6_K.gguf") }],
    isCatalogId: () => false,
  };
  const { models } = await M.scanLocalModels([{ dir: join(root, "real"), source: "other", maxDepth: 1 }], reg);
  assert.equal(models.length, 1);
  assert.equal(models[0].path, real);
  assert.equal(models[0].registered, true);
  assert.equal(models[0].modelId, "custom-local-p-1");
}));

test("bounded: the model cap stops the walk and says so; depth is kept per folder", () => fixtureAsync(async (root) => {
  for (let i = 0; i < 5; i++) gguf(join(root, "flat", `m${i}-Q4_0.gguf`));
  gguf(join(root, "deep", "a", "b", "c", "d", "deep-Q4_0.gguf"));
  const capped = await M.scanLocalModels([{ dir: join(root, "flat"), source: "other", maxDepth: 1 }], null, { maxModels: 2 });
  assert.equal(capped.models.length, 2);
  assert.equal(capped.truncated, true);
  const shallow = await M.scanLocalModels([{ dir: join(root, "deep"), source: "other", maxDepth: 3 }], null);
  assert.equal(shallow.models.length, 0);
  const deep = await M.scanLocalModels([{ dir: join(root, "deep"), source: "other", maxDepth: 5 }], null);
  assert.equal(deep.models.length, 1);
  const late = await M.scanLocalModels([{ dir: join(root, "flat"), source: "other", maxDepth: 1 }], null, { deadlineMs: -1 });
  assert.equal(late.models.length, 0);
  assert.equal(late.truncated, true);
  const missing = await M.scanLocalModels([{ dir: join(root, "nope"), source: "other", maxDepth: 2 }], null);
  assert.deepEqual(missing, { models: [], truncated: false });
}));

test("the guard: only a path the last scan returned", () => fixture(() => {
  M.rememberDiscovered([{ path: "/a/x.gguf", name: "x", sizeBytes: 1, source: "other", registered: false }]);
  assert.equal(M.discoveredModel("/a/x.gguf").name, "x");
  assert.equal(M.discoveredModel("/a/y.gguf"), null);
  assert.equal(M.discoveredModel("/a/../a/x.gguf"), null, "no normalising: the exact string only");
  assert.equal(M.discoveredModel(null), null);
  assert.equal(M.discoveredModel({ path: "/a/x.gguf" }), null);
  M.rememberDiscovered([]);
  assert.equal(M.discoveredModel("/a/x.gguf"), null, "a newer scan replaces the list");
}));
