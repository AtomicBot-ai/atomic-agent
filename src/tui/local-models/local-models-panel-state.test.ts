import { describe, expect, it } from "vitest";

import type { LocalModelDef } from "../../local-llm/index.js";
import {
  classifyVramFit,
  estimateModelVramNeedGb,
  MODEL_VRAM_HEADROOM,
} from "./local-models-panel-state.js";

function modelDef(fileSizeGb: number): LocalModelDef {
  return {
    id: "qwen-3.5-4b",
    name: "Test",
    filename: "x.gguf",
    huggingFaceUrl: "u",
    fileSizeGb,
    sizeLabel: `${fileSizeGb} GB`,
    description: "",
    maxContextLength: 1,
    contextLabel: "1",
    minRamGb: 1,
    recommendedRamGb: 1,
    family: "qwen",
    supportsVision: false,
  };
}

describe("estimateModelVramNeedGb", () => {
  it("applies the headroom multiplier to the file size", () => {
    expect(estimateModelVramNeedGb(modelDef(10))).toBeCloseTo(
      10 * MODEL_VRAM_HEADROOM,
      5,
    );
  });
});

describe("classifyVramFit", () => {
  it("returns null when the GPU budget is unknown", () => {
    expect(classifyVramFit(modelDef(10), null)).toBeNull();
  });

  it("returns 'insufficient' when the estimated need exceeds the budget", () => {
    // need = 10 * 1.2 = 12 GB > 8 GB
    expect(classifyVramFit(modelDef(10), 8)).toBe("insufficient");
  });

  it("returns 'ok' when the estimated need fits the budget", () => {
    // need = 4 * 1.2 = 4.8 GB <= 8 GB
    expect(classifyVramFit(modelDef(4), 8)).toBe("ok");
  });
});
