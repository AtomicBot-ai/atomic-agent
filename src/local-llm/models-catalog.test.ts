import { describe, expect, it } from "vitest";

import {
  DEFAULT_EMBEDDING_MODEL_ID,
  DEFAULT_LLAMACPP_MODEL_ID,
  EMBEDDING_MODELS_CATALOG,
  getEmbeddingModelDef,
  getLocalModelDef,
  isKnownEmbeddingModelId,
  LOCAL_MODELS_CATALOG,
} from "./models-catalog.js";

describe("models-catalog", () => {
  it("has exactly 9 Qwen+Gemma models with unique ids", () => {
    expect(LOCAL_MODELS_CATALOG.length).toBe(9);
    const ids = new Set(LOCAL_MODELS_CATALOG.map((m) => m.id));
    expect(ids.size).toBe(9);
  });

  it("defaults to qwen-3.5-4b", () => {
    expect(DEFAULT_LLAMACPP_MODEL_ID).toBe("qwen-3.5-4b");
  });

  // The bundled Qwen 3.5 override was a Qwen2.5-style ChatML template with
  // no `<think>` / `enable_thinking` markers. Because `--chat-template-file`
  // is what `/props.chat_template` reports back, it demoted the profile to
  // `plain-instruct` and deadlocked the grammar. See chat-templates.test.ts.
  it("does not override the Qwen 3.5 chat template", () => {
    expect(getLocalModelDef("qwen-3.5-4b").chatTemplateAsset).toBeUndefined();
    expect(getLocalModelDef("qwen-3.5-35b").chatTemplateAsset).toBeUndefined();
  });

  it("throws on unknown id", () => {
    expect(() =>
      getLocalModelDef("not-a-model" as import("./models-catalog.js").LocalModelId),
    ).toThrow(/unknown local model id/);
  });

  it("marks every catalog entry as vision-capable with mmproj URL", () => {
    expect(LOCAL_MODELS_CATALOG.length).toBeGreaterThan(0);
    for (const def of LOCAL_MODELS_CATALOG) {
      expect(def.supportsVision).toBe(true);
      expect(def.mmprojUrl).toMatch(/^https:\/\//);
      expect(def.mmprojFilename).toMatch(/\.gguf$/);
      expect(typeof def.mmprojFileSizeGb).toBe("number");
    }
  });

  it("ensures mmproj URL points at the same HF repo as the GGUF weights", () => {
    for (const def of LOCAL_MODELS_CATALOG) {
      if (!def.mmprojUrl) continue;
      const repo = (url: string) =>
        url.replace(/^https:\/\/huggingface\.co\//, "").split("/resolve/")[0];
      expect(repo(def.mmprojUrl)).toBe(repo(def.huggingFaceUrl));
    }
  });
});

describe("models-catalog (embedding)", () => {
  it("has unique embedding ids and at least one multilingual entry", () => {
    const ids = new Set(EMBEDDING_MODELS_CATALOG.map((m) => m.id));
    expect(ids.size).toBe(EMBEDDING_MODELS_CATALOG.length);
    expect(EMBEDDING_MODELS_CATALOG.length).toBeGreaterThanOrEqual(2);
    // bge-m3 is the load-bearing multilingual entry — Russian-speaking
    // operators rely on it. Pin its presence by id so it can't be
    // silently dropped during catalog edits.
    expect(ids.has("bge-m3")).toBe(true);
  });

  it("validates every embedding entry's invariants", () => {
    const validPoolings = new Set(["mean", "last", "cls", "rank"]);
    for (const def of EMBEDDING_MODELS_CATALOG) {
      expect(def.id).toBeTruthy();
      expect(def.huggingFaceUrl).toMatch(/^https:\/\/huggingface\.co\//);
      expect(def.huggingFaceUrl.endsWith(def.filename)).toBe(true);
      expect(def.dim).toBeGreaterThan(0);
      expect(validPoolings.has(def.pooling)).toBe(true);
      expect(def.fileSizeGb).toBeGreaterThan(0);
      expect(def.minRamGb).toBeGreaterThan(0);
      expect(def.recommendedRamGb).toBeGreaterThanOrEqual(def.minRamGb);
    }
  });

  it("default embedding model id resolves to a real catalog entry", () => {
    expect(isKnownEmbeddingModelId(DEFAULT_EMBEDDING_MODEL_ID)).toBe(true);
    expect(getEmbeddingModelDef(DEFAULT_EMBEDDING_MODEL_ID).id).toBe(
      DEFAULT_EMBEDDING_MODEL_ID,
    );
  });

  it("getEmbeddingModelDef throws on unknown ids", () => {
    expect(() =>
      getEmbeddingModelDef(
        "not-an-embedding" as import("./models-catalog.js").EmbeddingModelId,
      ),
    ).toThrow(/unknown embedding model id/);
  });
});
