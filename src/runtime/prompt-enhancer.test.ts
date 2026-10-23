import { describe, expect, it, vi } from "vitest";

import {
  PROMPT_ENHANCE_MAX_INPUT_CHARS,
  PROMPT_ENHANCE_MAX_TOKENS,
  PROMPT_ENHANCE_SESSION_PREFIX,
  enhancePrompt,
  extractEnhancedPromptText,
  sanitizeEnhancedPrompt,
  type PromptEnhanceDeps,
} from "./prompt-enhancer.js";

type Complete = PromptEnhanceDeps["complete"];

describe("enhancePrompt", () => {
  it("asks under its own partition and budget, not the conversation's", async () => {
    // The fallback chain keys breaker state by session id; on the bare
    // id a refusal here would flip the conversation's sticky override.
    const complete = vi.fn<Complete>(async () => ({ content: "Fix the login bug in auth.ts." }));
    const result = await enhancePrompt("fix login bug auth.ts", {
      complete,
      slotId: () => 3,
      sessionId: "s-1",
    });
    expect(result).toEqual({ ok: true, text: "Fix the login bug in auth.ts." });
    const params = complete.mock.calls[0]?.[0];
    if (params === undefined) throw new Error("expected an enhance request");
    expect(params.sessionId).toBe(`${PROMPT_ENHANCE_SESSION_PREFIX}s-1`);
    expect(params.slotId).toBe(3);
    expect(params.maxTokens).toBe(PROMPT_ENHANCE_MAX_TOKENS);
    expect(params.signal).toBeInstanceOf(AbortSignal);
    expect(params.prompt).toContain("fix login bug auth.ts");
    expect(params.chat?.enableThinking).toBe(false);
  });

  it("uses a draft partition before any session exists", async () => {
    const complete = vi.fn<Complete>(async () => ({ content: "Rewritten." }));
    await enhancePrompt("draft", { complete, slotId: () => 0 });
    expect(complete.mock.calls[0]?.[0]?.sessionId).toBe(`${PROMPT_ENHANCE_SESSION_PREFIX}draft`);
  });

  it("asks a cloud link through the sub-call request and reads the tool answer", async () => {
    const complete = vi.fn<Complete>(async () => ({
      content: "",
      toolCalls: [
        {
          id: "c1",
          type: "function" as const,
          function: { name: "emit_enhanced_prompt", arguments: JSON.stringify({ prompt: "Clear prompt." }) },
        },
      ],
    }));
    const result = await enhancePrompt("vague", {
      complete,
      slotId: () => 3,
      toolTransport: "native_tools",
    });
    expect(result).toEqual({ ok: true, text: "Clear prompt." });
    const params = complete.mock.calls[0]?.[0];
    if (params === undefined) throw new Error("expected an enhance request");
    expect(params.tools?.[0]).toMatchObject({ function: { name: "emit_enhanced_prompt" } });
    expect(params.toolChoice).toBe("auto");
    expect(params.maxTokens).toBe(PROMPT_ENHANCE_MAX_TOKENS);
    expect(params.slotId).toBe(-1);
  });

  it("sends the raw prompt alone when the operator turned templates off", async () => {
    const complete = vi.fn<Complete>(async () => ({ content: "Rewritten." }));
    await enhancePrompt("draft", { complete, slotId: () => 0, serverTemplate: false });
    expect(complete.mock.calls[0]?.[0]?.chat).toBeUndefined();
  });

  it("reports a failure instead of throwing, so the caller keeps the draft", async () => {
    const onError = vi.fn();
    const result = await enhancePrompt("draft", {
      complete: async () => {
        throw new Error("402 no credit");
      },
      slotId: () => 0,
      onError,
    });
    expect(result).toEqual({ ok: false, reason: "402 no credit" });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("gives up at its own deadline", async () => {
    const result = await enhancePrompt("draft", {
      complete: (params) =>
        new Promise((_, reject) => {
          params.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      slotId: () => 0,
      timeoutMs: 5,
    });
    expect(result).toEqual({ ok: false, reason: "timed out" });
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    const pending = enhancePrompt("draft", {
      complete: (params) =>
        new Promise((_, reject) => {
          params.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      slotId: () => 0,
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: "cancelled" });
  });

  it("refuses an empty or oversized draft without calling the model", async () => {
    const complete = vi.fn<Complete>(async () => ({ content: "x" }));
    expect((await enhancePrompt("   ", { complete, slotId: () => 0 })).ok).toBe(false);
    const long = "a".repeat(PROMPT_ENHANCE_MAX_INPUT_CHARS + 1);
    expect((await enhancePrompt(long, { complete, slotId: () => 0 })).ok).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it("fails on an answer that is nothing but reasoning", async () => {
    const result = await enhancePrompt("draft", {
      complete: async () => ({ content: "<think>let me see</think>" }),
      slotId: () => 0,
    });
    expect(result.ok).toBe(false);
  });
});

describe("sanitizeEnhancedPrompt", () => {
  it("drops the wrapping a model reaches for", () => {
    expect(sanitizeEnhancedPrompt("<think>hm</think>\nImproved prompt: Do X.")).toBe("Do X.");
    expect(sanitizeEnhancedPrompt("```\nDo X.\nThen Y.\n```")).toBe("Do X.\nThen Y.");
    expect(sanitizeEnhancedPrompt('"Do X."')).toBe("Do X.");
  });

  it("keeps quotes that are part of the prompt", () => {
    expect(sanitizeEnhancedPrompt('"a" and "b"')).toBe('"a" and "b"');
  });

  it("answers null when nothing survives", () => {
    expect(sanitizeEnhancedPrompt("  ")).toBeNull();
  });
});

describe("extractEnhancedPromptText", () => {
  it("falls back to prose when the tool arguments do not parse", () => {
    expect(
      extractEnhancedPromptText({
        content: "Prose answer.",
        toolCalls: [{ id: "c1", type: "function", function: { name: "emit_enhanced_prompt", arguments: "{oops" } }],
      }),
    ).toBe("Prose answer.");
  });
});
