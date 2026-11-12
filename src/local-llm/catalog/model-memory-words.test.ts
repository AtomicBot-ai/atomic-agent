import { describe, expect, it } from "vitest";

import {
  estimateRamGbFromFileSize,
  modelDisplayName,
  modelMemoryFit,
  modelMemoryNeedGb,
  modelMemoryNeedWords,
} from "./model-memory-words.js";
import { LOCAL_MODELS_CATALOG } from "./models-catalog.js";

describe("the one memory figure (ATO-1410)", () => {
  it("is the catalogue's recommendedRamGb for every curated model", () => {
    for (const def of LOCAL_MODELS_CATALOG) {
      expect(modelMemoryNeedGb(def), def.id).toBe(def.recommendedRamGb);
      expect(modelMemoryNeedWords(def), def.id).toBe(`needs ${def.recommendedRamGb} GB`);
      expect(def.minRamGb, def.id).toBeLessThanOrEqual(def.recommendedRamGb);
    }
  });

  it("splits a machine into the same three verdicts the desktop draws", () => {
    const gemma = LOCAL_MODELS_CATALOG.find((d) => d.id === "gemma-4-26b-a4b")!;
    expect(modelMemoryFit(gemma, 20)).toBe("comfortable");
    expect(modelMemoryFit(gemma, 16)).toBe("tight");
    expect(modelMemoryFit(gemma, 15)).toBe("over");
  });

  it("keeps the size rule the agent already stored for added models", () => {
    for (const gb of [0.3, 1, 2.4, 4.22, 7.9, 15.9, 22, 40.5, 70]) {
      expect(estimateRamGbFromFileSize(gb), String(gb)).toEqual({
        minRamGb: Math.max(1, Math.ceil(gb * 1.2)),
        recommendedRamGb: Math.max(2, Math.ceil(gb * 1.5) + 2),
      });
    }
    expect(estimateRamGbFromFileSize(Number.NaN)).toEqual({ minRamGb: 1, recommendedRamGb: 2 });
  });
});

describe("modelDisplayName", () => {
  it("drops the file-format tail from every curated name", () => {
    for (const def of LOCAL_MODELS_CATALOG) {
      const shown = modelDisplayName(def);
      expect(shown, def.id).not.toMatch(/GGUF$/);
      expect(shown, def.id).not.toBe(def.id);
    }
    expect(modelDisplayName({ id: "gemma-4-e4b", name: "Gemma 4 E4B QAT GGUF" })).toBe("Gemma 4 E4B");
    expect(modelDisplayName({ id: "qwen-3.5-4b", name: "Qwen 3.5 4B GGUF" })).toBe("Qwen 3.5 4B");
  });

  it("keeps an added model's name as written, and falls back to the id", () => {
    expect(
      modelDisplayName({ id: "custom-x", name: "unsloth/Qwen3-4B-GGUF · Qwen3-4B-UD-Q4_K_XL.gguf" }),
    ).toBe("unsloth/Qwen3-4B-GGUF · Qwen3-4B-UD-Q4_K_XL.gguf");
    expect(modelDisplayName({ id: "custom-y", name: "" })).toBe("custom-y");
    expect(modelDisplayName({ id: "custom-z" })).toBe("custom-z");
  });
});
