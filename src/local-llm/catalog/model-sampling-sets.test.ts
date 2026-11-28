import { describe, expect, it } from "vitest";

import {
  isEmptyLocalModelSampling,
  layerSampling,
  parseLocalModelSampling,
  samplingForMode,
  SamplingSetError,
} from "./model-sampling-sets.js";

const QWEN = {
  topK: 20,
  thinking: { temperature: 1, topP: 0.95 },
  noThinking: { temperature: 0.7, topP: 0.8 },
};

describe("model sampling sets (ATO-2482)", () => {
  it("picks the mode's set over the shared fields", () => {
    expect(samplingForMode(QWEN, "thinking")).toEqual({ temperature: 1, topP: 0.95, topK: 20 });
    expect(samplingForMode(QWEN, "noThinking")).toEqual({ temperature: 0.7, topP: 0.8, topK: 20 });
    expect(samplingForMode({ temperature: 1, topK: 64 }, "noThinking")).toEqual({ temperature: 1, topK: 64 });
    expect(samplingForMode(undefined, "thinking")).toEqual({});
  });

  it("layers one flat set over another field by field", () => {
    expect(layerSampling({ temperature: 0.5 }, { temperature: 1, topK: 20 })).toEqual({
      temperature: 0.5,
      topK: 20,
    });
  });

  it("validates a stored set and refuses a value llama.cpp would not take", () => {
    expect(parseLocalModelSampling({ ...QWEN, unknownKey: 3 }, "s")).toEqual(QWEN);
    expect(() => parseLocalModelSampling({ temperature: 70 }, "s")).toThrow(SamplingSetError);
    expect(() => parseLocalModelSampling({ noThinking: { topP: 0 } }, "s")).toThrow(/s\.noThinking\.topP/);
    expect(() => parseLocalModelSampling([1], "s")).toThrow(SamplingSetError);
  });

  it("reads an empty set, null and undefined as no set", () => {
    expect(parseLocalModelSampling({}, "s")).toBeUndefined();
    expect(parseLocalModelSampling({ thinking: {} }, "s")).toBeUndefined();
    expect(parseLocalModelSampling(null, "s")).toBeUndefined();
    expect(isEmptyLocalModelSampling({ noThinking: { minP: 0 } })).toBe(false);
  });
});
