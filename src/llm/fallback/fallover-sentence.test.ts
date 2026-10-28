import { describe, expect, it } from "vitest";

import { falloverSentence } from "./fallover-sentence.js";

describe("falloverSentence (ATO-483)", () => {
  it.each([
    ["rate_limited", "OpenRouter is rate-limited, switched to Gemini."],
    ["provider_trouble", "OpenRouter isn't answering right now, switched to Gemini."],
    ["offline", "OpenRouter isn't answering right now, switched to Gemini."],
    ["out_of_credit", "OpenRouter is out of credit, switched to Gemini."],
    ["auth_rejected", "OpenRouter did not accept the API key, switched to Gemini."],
    ["model_not_found", "OpenRouter doesn't have this model, switched to Gemini."],
    ["unknown", "OpenRouter failed, switched to Gemini."],
  ] as const)("%s", (failure, sentence) => {
    expect(falloverSentence("openrouter", "gemini", failure)).toBe(sentence);
  });

  it("names the fallback's model and quotes a custom entry id", () => {
    expect(falloverSentence("openrouter", "my-box", "rate_limited", "qwen3-32b")).toBe(
      'OpenRouter is rate-limited, switched to "my-box" (qwen3-32b).',
    );
  });
});
