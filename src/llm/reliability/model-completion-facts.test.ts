import { describe, expect, it } from "vitest";
import type { CompletionResult } from "../llama-server-client.js";
import { completionFactsOf } from "./model-completion-facts.js";

function makeCompletion(overrides: Partial<CompletionResult>): CompletionResult {
  return {
    content: "",
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 0, predictedTokens: 0 },
    cacheHitTokens: 0,
    slotId: -1,
    modelId: null,
    ...overrides,
  };
}

/** ATO-2421: which "empty" a failed completion was, by shape only. */
describe("completionFactsOf", () => {
  it("tells a model that only thought apart from a wholly empty one", () => {
    expect(completionFactsOf(makeCompletion({ reasoningContent: "let me think" })).reasoningPresent).toBe(true);
    expect(completionFactsOf(makeCompletion({ reasoningContent: "  \n" })).reasoningPresent).toBe(false);
  });

  it("keeps the OpenAI-shaped finish reason and the usage counts", () => {
    const facts = completionFactsOf(
      makeCompletion({
        finishReason: "stop",
        usage: { promptTokens: 4096, completionTokens: 1, totalTokens: 4097 },
      }),
    );
    expect(facts).toEqual({ finishReason: "stop", reasoningPresent: false, promptTokens: 4096, completionTokens: 1 });
  });

  it("falls back to llama-server timings and keeps its stop_type", () => {
    const facts = completionFactsOf(
      makeCompletion({
        stopType: "eos",
        timing: { promptMs: 10, predictedMs: 5, promptTokens: 9000, predictedTokens: 2 },
      }),
    );
    expect(facts).toEqual({
      finishReason: null,
      stopType: "eos",
      reasoningPresent: false,
      promptTokens: 9000,
      completionTokens: 2,
    });
  });

  it("reads zero-filled usage as unreported and uses the timings instead", () => {
    const facts = completionFactsOf(
      makeCompletion({
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        timing: { promptMs: 0, predictedMs: 0, promptTokens: 1200, predictedTokens: 0 },
      }),
    );
    expect(facts.promptTokens).toBe(1200);
    expect(facts.completionTokens).toBe(0);
  });

  it("never copies the reply or the reasoning text", () => {
    const facts = completionFactsOf(makeCompletion({ content: "secret reply", reasoningContent: "secret thought" }));
    expect(JSON.stringify(facts)).not.toContain("secret");
  });
});
