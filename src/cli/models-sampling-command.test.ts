import { describe, expect, it } from "vitest";

import { mergeSamplingValues, parseSamplingArgs } from "./models-sampling-command.js";
import { formatSamplingReport, type SamplingReport } from "./models-sampling-format.js";

describe("models sampling args (ATO-2482)", () => {
  it("reads the id, the values and the mode", () => {
    expect(parseSamplingArgs(["qwen-3.5-4b", "--no-thinking", "--temperature", "0.7", "--top-p", "0.8", "--json"]))
      .toEqual({ id: "qwen-3.5-4b", values: { temperature: 0.7, topP: 0.8 }, mode: "noThinking", reset: false, json: true });
    expect(parseSamplingArgs(["qwen-3.5-4b", "--reset"])).toMatchObject({ reset: true, values: {} });
  });

  it("refuses what it cannot do", () => {
    expect(parseSamplingArgs([])).toHaveProperty("error");
    expect(parseSamplingArgs(["a", "--temperature"])).toHaveProperty("error");
    expect(parseSamplingArgs(["a", "--temperature", "x"])).toHaveProperty("error");
    expect(parseSamplingArgs(["a", "--thinking", "--no-thinking"])).toHaveProperty("error");
    expect(parseSamplingArgs(["a", "--reset", "--top-k", "20"])).toHaveProperty("error");
    expect(parseSamplingArgs(["a", "b"])).toHaveProperty("error");
    expect(parseSamplingArgs(["a", "--wat"])).toHaveProperty("error");
  });

  it("merges new values into the person's set, per mode or for both", () => {
    expect(mergeSamplingValues({ temperature: 0.5 }, { topK: 30 }, "both")).toEqual({ temperature: 0.5, topK: 30 });
    expect(mergeSamplingValues({ temperature: 0.5, thinking: { topP: 0.9 } }, { temperature: 1 }, "thinking"))
      .toEqual({ temperature: 0.5, thinking: { topP: 0.9, temperature: 1 } });
    expect(mergeSamplingValues(null, { minP: 0 }, "noThinking")).toEqual({ noThinking: { minP: 0 } });
  });
});

describe("models sampling report (ATO-2482)", () => {
  const base: SamplingReport = {
    id: "qwen-3.5-4b",
    name: "Qwen3.5 4B",
    source: "default",
    custom: null,
    catalog: { topK: 20, thinking: { temperature: 1 }, noThinking: { temperature: 0.7 } },
    file: null,
    modelSampling: true,
  };

  it("shows the model's default per mode when it is used", () => {
    const text = formatSamplingReport(base);
    expect(text).toContain("Sampling: model default");
    expect(text).toContain("Thinking on:  temperature 1, top-k 20");
    expect(text).toContain("Thinking off: temperature 0.7, top-k 20");
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });

  it("says the model's own values are off and shows the person's set over the built-ins", () => {
    const text = formatSamplingReport({ ...base, modelSampling: false, source: "custom", custom: { temperature: 0.4 } });
    expect(text).toContain("Sampling: custom");
    expect(text).toContain("Thinking off: temperature 0.4");
    expect(text).toContain("localModels.modelSampling");
    expect(text).toContain("--reset");
  });
});
