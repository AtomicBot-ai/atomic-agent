import { describe, expect, it } from "vitest";

import * as schema from "../config-schema.js";
import { ConfigValidationError } from "../config-validation-error.js";
import { parseCustomLocalModel } from "../custom-models-schema.js";
import { parseModelSamplingOverrides } from "./model-sampling-config.js";

const CUSTOM = {
  id: "custom-fixture",
  filename: "w.gguf",
  huggingFaceUrl: "https://huggingface.co/a/b/resolve/main/w.gguf",
};

describe("per-model sampling in the config (ATO-2482)", () => {
  it("parses the override map and drops empty sets", () => {
    expect(
      parseModelSamplingOverrides(
        { "qwen-3.5-4b": { temperature: 0.6, noThinking: { topP: 0.8 } }, "gemma-4-e4b": {} },
        "f",
      ),
    ).toEqual({ "qwen-3.5-4b": { temperature: 0.6, noThinking: { topP: 0.8 } } });
    expect(parseModelSamplingOverrides(undefined, "f")).toBeUndefined();
    expect(parseModelSamplingOverrides({ x: {} }, "f")).toBeUndefined();
  });

  it("refuses a value out of range with the dotted field", () => {
    let caught: unknown;
    try {
      parseModelSamplingOverrides({ "qwen-3.5-4b": { topP: 2 } }, "localModels.modelSamplingOverrides");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught).toMatchObject({ field: "localModels.modelSamplingOverrides.qwen-3.5-4b.topP" });
    expect(() => parseModelSamplingOverrides([], "f")).toThrow(ConfigValidationError);
  });

  it("carries the map through the whole-file parse, absent when not set", () => {
    const parsed = schema.parseUserConfigFile({
      version: schema.USER_CONFIG_VERSION,
      localModels: { modelSamplingOverrides: { "qwen-3.5-4b": { temperature: 0.6 } } },
    });
    expect(parsed.localModels.modelSamplingOverrides).toEqual({ "qwen-3.5-4b": { temperature: 0.6 } });
    const plain = schema.parseUserConfigFile({ version: schema.USER_CONFIG_VERSION });
    expect(plain.localModels).not.toHaveProperty("modelSamplingOverrides");
  });

  it("keeps an added model's own sampling on its entry", () => {
    const def = parseCustomLocalModel({ ...CUSTOM, sampling: { temperature: 0.8, thinking: { topK: 30 } } }, "e");
    expect(def.sampling).toEqual({ temperature: 0.8, thinking: { topK: 30 } });
    expect(parseCustomLocalModel(CUSTOM, "e")).not.toHaveProperty("sampling");
    expect(() => parseCustomLocalModel({ ...CUSTOM, sampling: { minP: 3 } }, "e")).toThrow(/e\.sampling\.minP/);
  });
});
