import { describe, expect, it } from "vitest";

import { getLocalModelDef, type LocalModelDef } from "../../local-llm/index.js";
import { modelSamplingLine } from "./model-sampling-line.js";

describe("modelSamplingLine (ATO-2482)", () => {
  const qwen = getLocalModelDef("qwen-3.5-4b");

  it("says custom when the person set values, and how to go back", () => {
    const line = modelSamplingLine(qwen, { modelSamplingOverrides: { "qwen-3.5-4b": { temperature: 0.5 } } });
    expect(line).toContain("sampling: custom");
    expect(line).toContain("models sampling qwen-3.5-4b --reset");
  });

  it("says model default only when the model's values are in use", () => {
    expect(modelSamplingLine(qwen, { modelSampling: true })).toContain("sampling: model default");
    expect(modelSamplingLine(qwen, { modelSampling: false })).toContain("the model's own values are off");
    const own = { ...qwen, id: "custom-x", family: "custom", sampling: { topK: 10 } } as LocalModelDef;
    expect(modelSamplingLine(own, {})).toContain("sampling: custom");
  });
});
