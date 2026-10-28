import { describe, expect, it } from "vitest";

import { falloverSentence } from "./fallover-sentence.js";

describe("falloverSentence (ATO-483)", () => {
  it.each([
    ["rate_limited", "OpenRouter is rate-limited, answered with Gemini."],
    ["provider_trouble", "OpenRouter isn't answering right now, answered with Gemini."],
    ["offline", "OpenRouter isn't answering right now, answered with Gemini."],
    ["out_of_credit", "OpenRouter is out of credit, answered with Gemini."],
    ["auth_rejected", "OpenRouter did not accept the API key, answered with Gemini."],
    ["model_not_found", "OpenRouter doesn't have this model, answered with Gemini."],
    ["unknown", "OpenRouter failed, answered with Gemini."],
  ] as const)("%s", (failure, sentence) => {
    expect(falloverSentence("openrouter", "gemini", failure)).toBe(sentence);
  });

  it("names the fallback's model and quotes a custom entry id", () => {
    expect(falloverSentence("openrouter", "my-box", "rate_limited", "qwen3-32b")).toBe(
      'OpenRouter is rate-limited, answered with "my-box" (qwen3-32b).',
    );
  });
});
