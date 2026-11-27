import { describe, expect, it } from "vitest";
import { sanitizeLlmFailureTags } from "./llm-failure-tags.js";

/**
 * ATO-1678: the numbers a context-full report needs, as tags. Counts
 * only; anything that is not a non-negative count reads `unknown`.
 */
describe("sanitizeLlmFailureTags: prompt budget and cut counts (ATO-1678)", () => {
  it("sends each budget part and the server's counts", () => {
    const tags = sanitizeLlmFailureTags({
      promptBudget: {
        totalTokens: 27_000, stablePrefixTokens: 9_000, toolSchemaTokens: 6_000,
        conversationTokens: 11_000, contextWindow: 32_768, replyReserve: 4096,
      },
      truncationCounts: { promptTokens: 30_100, completionTokens: 2_660, requestedMaxTokens: 8192 },
    });
    expect(tags).toEqual({
      prompt_total_tokens: "27000",
      prompt_prefix_tokens: "9000",
      prompt_tools_tokens: "6000",
      prompt_history_tokens: "11000",
      prompt_window: "32768",
      prompt_reply_reserve: "4096",
      cut_prompt_tokens: "30100",
      cut_reply_tokens: "2660",
      cut_reply_cap: "8192",
    });
  });

  it("says none for an unknown window and a request without a cap", () => {
    const tags = sanitizeLlmFailureTags({
      promptBudget: {
        totalTokens: 1, stablePrefixTokens: 1, toolSchemaTokens: 0,
        conversationTokens: 0, contextWindow: null, replyReserve: null,
      },
      truncationCounts: { promptTokens: 0, completionTokens: 0 },
    });
    expect(tags?.prompt_window).toBe("none");
    expect(tags?.prompt_reply_reserve).toBe("unknown");
    expect(tags?.cut_reply_cap).toBe("none");
  });

  it("reads a zero cut count as not reported, not as zero tokens", () => {
    const tags = sanitizeLlmFailureTags({
      truncationCounts: { promptTokens: 0, completionTokens: 0, requestedMaxTokens: 4096 },
    });
    expect(tags?.cut_prompt_tokens).toBe("unknown");
    expect(tags?.cut_reply_tokens).toBe("unknown");
    expect(tags?.cut_reply_cap).toBe("4096");
  });

  it("never lets a non-count through", () => {
    const tags = sanitizeLlmFailureTags({
      truncationCounts: { promptTokens: Number.NaN, completionTokens: -3 },
    });
    expect(tags?.cut_prompt_tokens).toBe("unknown");
    expect(tags?.cut_reply_tokens).toBe("unknown");
  });
});

/**
 * ATO-2420: a context-size refusal's own numbers beside the budget, so a
 * report tells "our window was wrong" from "our estimate undercounted".
 */
describe("sanitizeLlmFailureTags: context overflow (ATO-2420)", () => {
  it("sends the server's window, its prompt count and how far the compaction got", () => {
    const tags = sanitizeLlmFailureTags({
      contextOverflow: { serverWindow: 32_768, serverPromptTokens: 40_123, compaction: "compacted_still_too_large" },
    });
    expect(tags).toEqual({
      overflow_server_window: "32768",
      overflow_server_prompt_tokens: "40123",
      overflow_compaction: "compacted_still_too_large",
    });
  });

  it("says none for numbers the server did not send, and unknown for a word outside the vocabulary", () => {
    const tags = sanitizeLlmFailureTags({
      contextOverflow: {
        serverWindow: null,
        serverPromptTokens: null,
        compaction: "something else" as unknown as "not_attempted",
      },
    });
    expect(tags?.overflow_server_window).toBe("none");
    expect(tags?.overflow_server_prompt_tokens).toBe("none");
    expect(tags?.overflow_compaction).toBe("unknown");
  });
});
