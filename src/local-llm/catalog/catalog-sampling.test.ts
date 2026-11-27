import { describe, expect, it } from "vitest";

import { samplingForMode } from "./model-sampling-sets.js";
import { getLocalModelDef, LOCAL_MODELS_CATALOG } from "./models-catalog.js";

describe("catalog sampling (ATO-2482)", () => {
  it("names a set on every curated chat entry", () => {
    const missing = LOCAL_MODELS_CATALOG.filter((m) => m.sampling === undefined).map((m) => m.id);
    expect(missing).toEqual([]);
  });

  it("gives Qwen a thinking-off set and Gemma one set for both modes", () => {
    const qwen = getLocalModelDef("qwen-3.5-4b").sampling;
    expect(samplingForMode(qwen, "thinking")).toMatchObject({ temperature: 1, topP: 0.95, topK: 20 });
    expect(samplingForMode(qwen, "noThinking")).toMatchObject({ temperature: 0.7, topP: 0.8, topK: 20 });
    const gemma = getLocalModelDef("gemma-4-e4b").sampling;
    expect(samplingForMode(gemma, "noThinking")).toEqual(samplingForMode(gemma, "thinking"));
    expect(samplingForMode(gemma, "thinking")).toEqual({ temperature: 1, topP: 0.95, topK: 64 });
  });

  it("leaves presence_penalty out of every catalog set until the fit-test", () => {
    for (const m of LOCAL_MODELS_CATALOG) {
      for (const mode of ["thinking", "noThinking"] as const) {
        expect(samplingForMode(m.sampling, mode).presencePenalty).toBeUndefined();
      }
    }
  });
});
