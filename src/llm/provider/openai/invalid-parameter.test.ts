import { describe, expect, it } from "vitest";
import { invalidSamplingParameter } from "./invalid-parameter.js";

describe("invalidSamplingParameter (ATO-1218)", () => {
  it("names the refused setting in the wordings providers use", () => {
    expect(invalidSamplingParameter("invalid temperature: only 1 is allowed for this model")).toBe("temperature");
    expect(invalidSamplingParameter("top_p must be between 0 and 1")).toBe("top_p");
    expect(
      invalidSamplingParameter("Unsupported value: 'temperature' does not support 0.2 with this model."),
    ).toBe("temperature");
    expect(invalidSamplingParameter("`temperature` is deprecated for this model.")).toBe("temperature");
    expect(invalidSamplingParameter("Unknown parameter: 'repetition_penalty'.")).toBe("repetition_penalty");
  });

  it("is null for refusals of other fields", () => {
    expect(invalidSamplingParameter("unsupported parameter: tools")).toBeNull();
    expect(
      invalidSamplingParameter(
        "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      ),
    ).toBeNull();
    expect(invalidSamplingParameter("Please pass a valid API key")).toBeNull();
  });

  it("is null when the setting is only echoed far from the refusal", () => {
    const echo =
      "invalid 'messages[3].content': expected a string." +
      " ".repeat(200) +
      '{"model":"x","temperature":0.2}';
    expect(invalidSamplingParameter(echo)).toBeNull();
  });
});
