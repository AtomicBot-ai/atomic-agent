import { describe, expect, it } from "vitest";

import {
  DEFAULT_LLAMACPP_MODEL_ID,
  getLocalModelDef,
  LOCAL_MODELS_CATALOG,
} from "./models-catalog.js";

describe("models-catalog", () => {
  it("has exactly 8 Qwen+Gemma models with unique ids", () => {
    expect(LOCAL_MODELS_CATALOG.length).toBe(8);
    const ids = new Set(LOCAL_MODELS_CATALOG.map((m) => m.id));
    expect(ids.size).toBe(8);
  });

  it("defaults to qwen-3.5-4b", () => {
    expect(DEFAULT_LLAMACPP_MODEL_ID).toBe("qwen-3.5-4b");
  });

  it("resolves qwen-3.5-4b chat template asset", () => {
    expect(getLocalModelDef("qwen-3.5-4b").chatTemplateAsset).toBe(
      "qwen3.5-chat-template.jinja",
    );
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
