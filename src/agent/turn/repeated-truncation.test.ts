import { describe, expect, it } from "vitest";
import { ModelError } from "../../llm/index.js";
import type { TruncationDetail } from "../../llm/index.js";
import { repeatedTruncationError } from "./repeated-truncation.js";
import { createTurnLoopState } from "./turn-state.js";

function cut(detail: Partial<TruncationDetail> = {}): ModelError {
  return new ModelError("truncated", "model response truncated at 16384 tokens", {
    transport: "native_tools",
    stage: "initial",
    truncation: { cause: "reply_cap", completionTokens: 16_384, promptTokens: 28_000, requestedMaxTokens: 16_384, ...detail },
    completion: { finishReason: "length", reasoningPresent: true, promptTokens: 28_000, completionTokens: 16_384 },
  });
}

function retried(original: Error, stepIndex = 0) {
  const turn = createTurnLoopState();
  turn.truncationRetry = { stepIndex, attempts: 1, original };
  turn.truncationRetries = 1;
  return turn;
}

describe("repeatedTruncationError (ATO-1678)", () => {
  it("leaves a step's first cut alone", () => {
    expect(repeatedTruncationError(cut(), 0, createTurnLoopState())).toBeNull();
    // A retry taken by an earlier step does not count for this one.
    expect(repeatedTruncationError(cut(), 3, retried(cut(), 2))).toBeNull();
  });

  it("wraps a cut after the step's retry, keeping every report field", () => {
    const again = cut({ part: "tool_call", cutTool: "os.fs.write" });
    const wrapped = repeatedTruncationError(again, 0, retried(cut()));
    expect(wrapped).toBeInstanceOf(ModelError);
    expect(wrapped).toMatchObject({
      reason: "truncated",
      repeatedCut: "cut",
      transport: "native_tools",
      stage: "initial",
      truncation: again.truncation,
      completion: again.completion,
      cause: again,
    });
    expect(wrapped?.message).toBe(
      "model response truncated at 16384 tokens; cut again after the agent asked for smaller pieces",
    );
  });

  it("is a loop only when both cuts looped", () => {
    const looped = () => cut({ repetitive: true });
    expect(repeatedTruncationError(looped(), 0, retried(looped()))?.repeatedCut).toBe("loop");
    expect(repeatedTruncationError(looped(), 0, retried(cut()))?.repeatedCut).toBe("cut");
    expect(repeatedTruncationError(cut(), 0, retried(looped()))?.repeatedCut).toBe("cut");
  });

  it("counts a spent turn budget, but never a full window or another error", () => {
    const turn = createTurnLoopState();
    turn.truncationRetries = 6;
    expect(repeatedTruncationError(cut(), 5, turn)?.repeatedCut).toBe("cut");
    expect(repeatedTruncationError(cut({ cause: "context_window" }), 0, retried(cut()))).toBeNull();
    expect(repeatedTruncationError(new ModelError("empty", "empty"), 0, retried(cut()))).toBeNull();
    expect(repeatedTruncationError(new Error("plain"), 0, retried(cut()))).toBeNull();
  });
});
