import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { densePairs, encodeSyntheticGguf } from "../catalog/gguf-metadata.fixtures.js";
import {
  LINKED_MODELS_DIR,
  adoptExternalModel,
  checkServableGguf,
  linkedFileName,
  modelBlobFromManifest,
  ollamaManifestPath,
  type AdoptOptions,
} from "./adopt-external-model.js";
import type { HostPaths } from "./external-server-paths.js";

const DIGEST = "sha256:" + "a".repeat(64);
const noOllama = { fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch };
const noLms = { bin: null };

let root: string;
let ollamaDir: string;
let host: HostPaths;
let opts: AdoptOptions;

function writeOllamaModel(name: string, blob: Buffer): string {
  const manifest = ollamaManifestPath(ollamaDir, name);
  mkdirSync(join(manifest, ".."), { recursive: true });
  writeFileSync(manifest, JSON.stringify({
    layers: [
      { mediaType: "application/vnd.ollama.image.template", digest: "sha256:" + "b".repeat(64) },
      { mediaType: "application/vnd.ollama.image.model", digest: DIGEST },
    ],
  }));
  const path = join(ollamaDir, "blobs", DIGEST.replace(":", "-"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, blob);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adopt-"));
  ollamaDir = join(root, "ollama-models");
  host = { platform: process.platform, home: join(root, "home"), env: { OLLAMA_MODELS: ollamaDir } };
  opts = { dataDir: join(root, "data"), managedModelsDir: join(root, "data", "models"), host, ollama: noOllama, lms: noLms };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("using an Ollama or LM Studio model on our engine (ATO-2490)", () => {
  it("Ollama's manifest layout: library namespace, tag, other registries", () => {
    expect(ollamaManifestPath("/m", "qwen3:8b")).toBe(join("/m", "manifests", "registry.ollama.ai", "library", "qwen3", "8b"));
    expect(ollamaManifestPath("/m", "llama3.2")).toBe(join("/m", "manifests", "registry.ollama.ai", "library", "llama3.2", "latest"));
    expect(ollamaManifestPath("/m", "hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M"))
      .toBe(join("/m", "manifests", "hf.co", "bartowski", "Qwen3-8B-GGUF", "Q4_K_M"));
    expect(modelBlobFromManifest("/m", JSON.stringify({ layers: [{ mediaType: "application/vnd.ollama.image.model", digest: DIGEST }] })))
      .toBe(join("/m", "blobs", DIGEST.replace(":", "-")));
    expect(modelBlobFromManifest("/m", '{"layers":[{"mediaType":"application/vnd.ollama.image.model","digest":"../x"}]}')).toBeNull();
    expect(linkedFileName("ollama", "hf.co/Bartowski/Qwen3:Q4")).toBe("ollama-hf.co-bartowski-qwen3-q4.gguf");
  });

  it("an Ollama blob is hard-linked as a .gguf and survives ollama rm", async () => {
    const blob = writeOllamaModel("qwen3:8b", encodeSyntheticGguf({ ...densePairs(), "tokenizer.chat_template": "{{ messages }}" }));
    const r = await adoptExternalModel("ollama", "qwen3:8b", opts);
    expect(r.how).toBe("hardlink");
    expect(r.path).toBe(join(opts.dataDir, LINKED_MODELS_DIR, "ollama-qwen3-8b.gguf"));
    expect(r.sourcePath).toBe(blob);
    expect(r.def.localPath).toBe(r.path);
    expect(r.def.name).toBe("qwen3:8b (from Ollama)");
    rmSync(blob);
    expect(statSync(r.path).isFile()).toBe(true);
    // Doing it again refreshes the same entry instead of adding a second.
    writeOllamaModel("qwen3:8b", encodeSyntheticGguf({ ...densePairs(), "tokenizer.chat_template": "{{ messages }}" }));
    expect((await adoptExternalModel("ollama", "qwen3:8b", opts)).def.id).toBe(r.def.id);
  });

  it("no chat template inside: refused, nothing linked", async () => {
    writeOllamaModel("raw:1b", encodeSyntheticGguf(densePairs()));
    await expect(adoptExternalModel("ollama", "raw:1b", opts)).rejects.toThrow("has no chat template inside its file");
  });

  it("a blob that is not GGUF: refused in words", async () => {
    const path = join(root, "not-gguf.bin");
    writeFileSync(path, Buffer.from("PK\u0003\u0004 safetensors"));
    await expect(checkServableGguf(path, "x from Ollama")).rejects.toThrow("is not stored as a GGUF file");
  });

  it("a model Ollama does not have: the sentence names it", async () => {
    await expect(adoptExternalModel("ollama", "missing:7b", opts)).rejects.toThrow("Could not find the file of missing:7b");
  });

  it("LM Studio's .gguf is used where it lies, found without lms", async () => {
    const dir = join(host.home, ".lmstudio", "models", "lmstudio-community", "Qwen3-8B-GGUF");
    mkdirSync(dir, { recursive: true });
    const gguf = join(dir, "Qwen3-8B-Q4_K_M.gguf");
    writeFileSync(gguf, encodeSyntheticGguf({ ...densePairs(), "tokenizer.chat_template": "{{ x }}" }));
    writeFileSync(join(dir, "mmproj-Qwen3-8B.gguf"), encodeSyntheticGguf({ "tokenizer.chat_template": "x" }));
    const r = await adoptExternalModel("lmstudio", "qwen/qwen3-8b", opts);
    expect(r.how).toBe("in-place");
    expect(r.path).toBe(gguf);
    expect(r.def.name).toBe("qwen/qwen3-8b (from LM Studio)");
  });
});
