import { describe, it, expect } from "vitest";
import type { CompletionResult } from "../llama-server-client.js";
import { detectModelFailure } from "./detect-model-failure.js";

function makeCompletion(
  overrides: Partial<CompletionResult>,
): CompletionResult {
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

  it("names the reply cap when the reply spent it", () => {
    const completion = makeCompletion({
      content: "",
      truncated: true,
      usage: {
        promptTokens: 6_000,
        completionTokens: 8_192,
        totalTokens: 14_192,
      },
    });
    const result = detectModelFailure(completion, {
      requestedMaxTokens: 8_192,
    });
    expect(result?.reason).toBe("truncated");
    expect(result?.truncation).toEqual({
      cause: "reply_cap",
      completionTokens: 8_192,
      promptTokens: 6_000,
      requestedMaxTokens: 8_192,
    });
    expect(result?.message).toContain("at 8192 tokens");
    expect(result?.message).toContain("localModels.completionMaxTokens");
    expect(result?.message).toContain("8192");
  });

  it("treats a reply within a few tokens of the cap as having spent it", () => {
    // llama.cpp stops one short of `n_predict` after the stop-token test.
    const completion = makeCompletion({
      content: "",
      truncated: true,
      usage: { promptTokens: 100, completionTokens: 8_190, totalTokens: 8_290 },
    });
    expect(
      detectModelFailure(completion, { requestedMaxTokens: 8_192 })?.truncation
        ?.cause,
    ).toBe("reply_cap");
  });

  it("blames the context window when the reply stopped short of the cap", () => {
    const completion = makeCompletion({
      content: "",
      truncated: true,
      usage: {
        promptTokens: 30_000,
        completionTokens: 2_768,
        totalTokens: 32_768,
      },
    });
    const result = detectModelFailure(completion, {
      requestedMaxTokens: 8_192,
    });
    expect(result?.truncation?.cause).toBe("context_window");
    expect(result?.message).toContain("ran out of context");
    expect(result?.message).toContain("30000-token prompt");
    expect(result?.message).toContain("larger context size");
  });

  it("blames the provider's output limit when a known window is nowhere near full", () => {
    // OpenRouter/Groq-style clamp: a 128k model whose route caps output
    // at 4096. Learning 10k as the window here would shrink every later
    // prompt for nothing.
    const completion = makeCompletion({
      content: "",
      truncated: true,
      usage: {
        promptTokens: 6_000,
        completionTokens: 4_096,
        totalTokens: 10_096,
      },
    });
    const result = detectModelFailure(completion, {
      requestedMaxTokens: 8_192,
      contextWindow: 131_072,
    });
    expect(result?.truncation?.cause).toBe("output_limit");
    expect(result?.message).toContain("output limit is about 4096 tokens");
    expect(result?.message).toContain("lower the cap");
  });

  it("still blames the window when prompt + reply reach it", () => {
    const completion = makeCompletion({
      content: "",
      truncated: true,
      usage: {
        promptTokens: 30_000,
        completionTokens: 2_700,
        totalTokens: 32_700,
      },
    });
    expect(
      detectModelFailure(completion, {
        requestedMaxTokens: 8_192,
        contextWindow: 32_768,
      })?.truncation?.cause,
    ).toBe("context_window");
  });

  it("says it cannot tell when the provider reported no usage", () => {
    const completion = makeCompletion({ content: "", truncated: true });
    const result = detectModelFailure(completion, {
      requestedMaxTokens: 8_192,
    });
    expect(result?.truncation?.cause).toBe("unknown");
    expect(result?.message).toContain("8192-token reply cap");
    expect(result?.message).toContain("context window");
    expect(result?.message).toContain("no token counts");
  });

  it("names the repair pass's own cap on the repair stage", () => {
    const completion = makeCompletion({
      content: "",
      truncated: true,
      usage: { promptTokens: 100, completionTokens: 1_024, totalTokens: 1_124 },
    });
    const result = detectModelFailure(completion, {
      requestedMaxTokens: 1_024,
      stage: "repair",
    });
    expect(result?.message).toContain("repair pass");
    expect(result?.message).not.toContain("localModels.completionMaxTokens");
  });

  it("reads llama-server timings when there is no usage block", () => {
    // The grammar path reports `predicted_n`, never `usage`, and its
    // `truncated` flag means one thing: the context overflowed. Even a
    // count that lands on the cap is the window there.
    const completion = makeCompletion({
      content: "",
      truncated: true,
      timing: {
        promptMs: 1,
        predictedMs: 1,
        promptTokens: 7_000,
        predictedTokens: 900,
      },
    });
    expect(
      detectModelFailure(completion, { requestedMaxTokens: 8_192 })?.truncation,
    ).toEqual({
      cause: "context_window",
      completionTokens: 900,
      promptTokens: 7_000,
      requestedMaxTokens: 8_192,
    });
    const onTheCap = makeCompletion({
      content: "",
      truncated: true,
      timing: {
        promptMs: 1,
        predictedMs: 1,
        promptTokens: 7_000,
        predictedTokens: 8_192,
      },
    });
    expect(
      detectModelFailure(onTheCap, { requestedMaxTokens: 8_192 })?.truncation
        ?.cause,
    ).toBe("context_window");
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
