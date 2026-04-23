import { describe, it, expect } from "vitest";
import type { CompletionResult } from "../llama-server-client.js";
import { detectModelFailure } from "./detect-model-failure.js";

function makeCompletion(overrides: Partial<CompletionResult>): CompletionResult {
  return {
    content: "",
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: {
      promptMs: 0,
      predictedMs: 0,
      promptTokens: 0,
      predictedTokens: 0,
    },
    cacheHitTokens: 0,
    slotId: -1,
    modelId: null,
    ...overrides,
  };
}

describe("detectModelFailure", () => {
  it("returns null for a well-formed completion", () => {
    const completion = makeCompletion({
      content: '{"tool":"reply","args":{"text":"hi"}}',
      stop: true,
      truncated: false,
    });
    expect(detectModelFailure(completion)).toBeNull();
  });

  it("reports truncation as the top priority", () => {
    const completion = makeCompletion({
      content: '{"tool":"reply","args":{"text":"hi"}}',
      truncated: true,
      timing: {
        promptMs: 10,
        predictedMs: 10,
        promptTokens: 1,
        predictedTokens: 256,
      },
    });
    const result = detectModelFailure(completion);
    expect(result?.reason).toBe("truncated");
    expect(result?.message).toMatch(/256/);
  });

  it("reports empty output when content is blank", () => {
    const completion = makeCompletion({
      content: "   ",
      reasoningContent: "",
      stop: true,
    });
    expect(detectModelFailure(completion)?.reason).toBe("empty");
  });

  it("still flags empty when only reasoning channel carried text", () => {
    const completion = makeCompletion({
      content: "",
      reasoningContent: "thought without acting",
      stop: true,
    });
    expect(detectModelFailure(completion)?.reason).toBe("empty");
  });

  it("flags no_stop when stream ended mid-generation without a closed object", () => {
    const completion = makeCompletion({
      content: '{"tool":"reply","args":{"text":"hello wor',
      stop: false,
      truncated: false,
    });
    expect(detectModelFailure(completion)?.reason).toBe("no_stop");
  });

  it("does not flag no_stop when content already ends with a closed object", () => {
    const completion = makeCompletion({
      content: '{"tool":"reply","args":{"text":"done"}}',
      stop: false,
      truncated: false,
    });
    expect(detectModelFailure(completion)).toBeNull();
  });
});
