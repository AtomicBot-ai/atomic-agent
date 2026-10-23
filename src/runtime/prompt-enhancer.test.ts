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

describe("enhancePrompt against the person's own text", () => {
  it("keeps a draft's own <think> tags in a prose answer", async () => {
    const draft = "Explain why the parser drops <think> blocks before the answer.";
    const rewrite = "Explain why the parser drops <think> blocks that appear before the answer, with an example.";
    const result = await enhancePrompt(draft, {
      complete: async () => ({ content: rewrite }),
      slotId: () => 0,
    });
    expect(result).toEqual({ ok: true, text: rewrite });
  });

  it("never strips reasoning out of the tool arguments", async () => {
    const rewrite = "Rename <think> to <reasoning> in the template and keep the tests passing.";
    const result = await enhancePrompt("rename think tag to reasoning", {
      complete: async () => ({
        content: "",
        toolCalls: [{ function: { name: "emit_enhanced_prompt", arguments: JSON.stringify({ prompt: rewrite }) } }],
      }),
      slotId: () => 0,
      toolTransport: "native_tools",
    });
    expect(result).toEqual({ ok: true, text: rewrite });
  });

  it("refuses a rewrite that came back much shorter than the draft", async () => {
    const draft = "Add retry with backoff to the uploader, keep the 3 attempt cap, log each retry, and update the docs.";
    const result = await enhancePrompt(draft, {
      complete: async () => ({ content: "Add retry." }),
      slotId: () => 0,
    });
    expect(result.ok).toBe(false);
  });
});

describe("enhancePrompt lifecycle", () => {
  it("holds its controller in the pending set only while it runs", async () => {
    const pending = new Set<AbortController>();
    let seen = 0;
    const result = await enhancePrompt("draft", {
      complete: async () => {
        seen = pending.size;
        return { content: "Rewritten draft." };
      },
      slotId: () => 0,
      pending,
    });
    expect(result.ok).toBe(true);
    expect(seen).toBe(1);
    expect(pending.size).toBe(0);
  });

  it("stops when shutdown aborts the pending set", async () => {
    const pending = new Set<AbortController>();
    const call = enhancePrompt("draft", {
      complete: (params) =>
        new Promise((_, reject) => {
          params.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      slotId: () => 0,
      pending,
    });
    for (const controller of pending) controller.abort();
    expect(await call).toEqual({ ok: false, reason: "cancelled" });
    expect(pending.size).toBe(0);
  });

  it("reports a failure building the request and still cleans up", async () => {
    const pending = new Set<AbortController>();
    const result = await enhancePrompt("draft", {
      complete: async () => ({ content: "x" }),
      slotId: () => {
        throw new Error("no slot");
      },
      pending,
    });
    expect(result).toEqual({ ok: false, reason: "no slot" });
    expect(pending.size).toBe(0);
  });
});

describe("sanitizeEnhancedPrompt", () => {
  it("drops the wrapping a model reaches for", () => {
    const draft = "do x";
    expect(sanitizeEnhancedPrompt("<think>hm</think>\nImproved prompt: Do X.", { draft })).toBe("Do X.");
    expect(sanitizeEnhancedPrompt("```\nDo X.\nThen Y.\n```", { draft })).toBe("Do X.\nThen Y.");
    expect(sanitizeEnhancedPrompt('"Do X."', { draft })).toBe("Do X.");
  });

  it("keeps quotes that are part of the prompt", () => {
    expect(sanitizeEnhancedPrompt('"a" and "b"', { draft: "a and b" })).toBe('"a" and "b"');
  });

  it("keeps the quotes of a wholly quoted draft", () => {
    expect(sanitizeEnhancedPrompt('"Say hello."', { draft: '"say hello"' })).toBe('"Say hello."');
  });

  it("keeps a leading Prompt: label the draft itself opens with", () => {
    expect(sanitizeEnhancedPrompt("Prompt: a haiku about rain.", { draft: "prompt: haiku rain" })).toBe(
      "Prompt: a haiku about rain.",
    );
  });

  it("does not merge two separate code blocks into one", () => {
    const two = "```\na()\n```\nthen\n```\nb()\n```";
    expect(sanitizeEnhancedPrompt(two, { draft: "run a then b" })).toBe(two);
  });

  it("keeps reasoning-looking text the draft itself contains", () => {
    expect(
      sanitizeEnhancedPrompt("Thinking process: write it as a numbered list.", { draft: "Thinking process: list it" }),
    ).toBe("Thinking process: write it as a numbered list.");
  });

  it("answers null when nothing survives", () => {
    expect(sanitizeEnhancedPrompt("  ", { draft: "x" })).toBeNull();
  });
});

describe("extractEnhancedPromptText", () => {
  it("falls back to prose when the tool arguments do not parse", () => {
    expect(
      extractEnhancedPromptText({
        content: "Prose answer.",
        toolCalls: [{ id: "c1", type: "function", function: { name: "emit_enhanced_prompt", arguments: "{oops" } }],
      }),
    ).toEqual({ text: "Prose answer.", fromTool: false });
  });

  it("falls back to prose when the tool returns an empty prompt", () => {
    expect(
      extractEnhancedPromptText({
        content: "Prose answer.",
        toolCalls: [{ function: { name: "emit_enhanced_prompt", arguments: JSON.stringify({ prompt: "" }) } }],
      }),
    ).toEqual({ text: "Prose answer.", fromTool: false });
  });
});
