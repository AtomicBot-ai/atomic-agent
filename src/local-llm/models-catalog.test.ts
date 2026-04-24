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
});
