import { describe, expect, it, vi } from "vitest";

import {
  PLAIN_COMPLETE_DEFAULT_MAX_TOKENS,
  PLAIN_COMPLETE_DEFAULT_SYSTEM,
  PLAIN_COMPLETE_MAX_PROMPT_CHARS,
  PLAIN_COMPLETE_MAX_TOKENS_CAP,
  PLAIN_COMPLETE_PARTITION,
  completePlain,
  extractPlainCompleteText,
  plainCompleteMaxTokens,
  validatePlainCompleteInput,
  type PlainCompleteDeps,
} from "./plain-complete.js";

type Complete = PlainCompleteDeps["complete"];

describe("validatePlainCompleteInput", () => {
  it("accepts a prompt with optional system and max tokens", () => {
    expect(validatePlainCompleteInput({ prompt: "hi" })).toBeNull();
    expect(validatePlainCompleteInput({ prompt: "hi", system: "be brief", maxTokens: 200 })).toBeNull();
  });

  it("refuses an empty, non-string or oversized prompt", () => {
    expect(validatePlainCompleteInput({ prompt: "" })).toMatch(/prompt/);
    expect(validatePlainCompleteInput({ prompt: "   " })).toMatch(/prompt/);
    expect(validatePlainCompleteInput({ prompt: 42 })).toMatch(/prompt/);
    expect(
      validatePlainCompleteInput({ prompt: "x".repeat(PLAIN_COMPLETE_MAX_PROMPT_CHARS + 1) }),
    ).toMatch(/too long/);
  });

  it("refuses a bad system or max tokens", () => {
    expect(validatePlainCompleteInput({ prompt: "hi", system: 1 })).toMatch(/system/);
    expect(validatePlainCompleteInput({ prompt: "hi", maxTokens: 0 })).toMatch(/max_tokens/);
    expect(validatePlainCompleteInput({ prompt: "hi", maxTokens: 1.5 })).toMatch(/max_tokens/);
    expect(validatePlainCompleteInput({ prompt: "hi", maxTokens: "9" })).toMatch(/max_tokens/);
  });
});

describe("plainCompleteMaxTokens", () => {
  it("defaults, passes through and clamps to the cap", () => {
    expect(plainCompleteMaxTokens(undefined)).toBe(PLAIN_COMPLETE_DEFAULT_MAX_TOKENS);
    expect(plainCompleteMaxTokens(300)).toBe(300);
    expect(plainCompleteMaxTokens(1_000_000)).toBe(PLAIN_COMPLETE_MAX_TOKENS_CAP);
  });
});

describe("extractPlainCompleteText", () => {
  it("reads the emit tool's text argument first", () => {
    expect(
      extractPlainCompleteText({
        content: "",
        toolCalls: [
          { id: "c", type: "function", function: { name: "emit_answer", arguments: '{"text":" Done. "}' } },
        ],
      }),
    ).toBe("Done.");
  });

  it("falls back to content with reasoning taken out", () => {
    expect(extractPlainCompleteText({ content: "<think>hmm</think>A bright red fox" })).toBe(
      "A bright red fox",
    );
  });
});

describe("completePlain", () => {
  it("asks under its own partition, bounded, with thinking off on a local link", async () => {
    const complete = vi.fn<Complete>(async () => ({ content: "Better prompt." }));
    const result = await completePlain(
      { prompt: "a cat", system: "Rewrite image prompts.", maxTokens: 500 },
      { complete, slotId: () => 2 },
    );
    expect(result).toEqual({ ok: true, text: "Better prompt." });
    const params = complete.mock.calls[0]?.[0];
    if (params === undefined) throw new Error("expected a request");
    expect(params.sessionId).toBe(PLAIN_COMPLETE_PARTITION);
    expect(params.slotId).toBe(2);
    expect(params.maxTokens).toBe(500);
    expect(params.tools).toBeUndefined();
    expect(params.chat?.system).toBe("Rewrite image prompts.");
    expect(params.chat?.user).toBe("a cat");
    expect(params.chat?.enableThinking).toBe(false);
    expect(params.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the default system and no chat parts when the server template is off", async () => {
    const complete = vi.fn<Complete>(async () => ({ content: "ok" }));
    await completePlain({ prompt: "a cat" }, { complete, slotId: () => 0, serverTemplate: false });
    const params = complete.mock.calls[0]?.[0];
    expect(params?.chat).toBeUndefined();
    expect(params?.prompt).toContain(PLAIN_COMPLETE_DEFAULT_SYSTEM);
    expect(params?.prompt).toContain("a cat");
    expect(params?.maxTokens).toBe(PLAIN_COMPLETE_DEFAULT_MAX_TOKENS);
  });

  it("asks a cloud link through one emit function and no slot affinity", async () => {
    const complete = vi.fn<Complete>(async () => ({
      content: "",
      toolCalls: [
        { id: "c", type: "function" as const, function: { name: "emit_answer", arguments: '{"text":"Clear."}' } },
      ],
    }));
    const result = await completePlain(
      { prompt: "vague" },
      { complete, slotId: () => 7, toolTransport: "native_tools" },
    );
    expect(result).toEqual({ ok: true, text: "Clear." });
    const params = complete.mock.calls[0]?.[0];
    expect(params?.slotId).toBe(-1);
    expect(params?.tools).toHaveLength(1);
    expect(params?.tools?.[0]?.function.name).toBe("emit_answer");
    expect(params?.maxTokens).toBe(PLAIN_COMPLETE_DEFAULT_MAX_TOKENS);
  });

  it("refuses a bad request without calling the model", async () => {
    const complete = vi.fn<Complete>(async () => ({ content: "x" }));
    const result = await completePlain({ prompt: "" }, { complete, slotId: () => 0 });
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("reports an empty answer and a provider error as failures", async () => {
    const empty = await completePlain(
      { prompt: "hi" },
      { complete: async () => ({ content: "  " }), slotId: () => 0 },
    );
    expect(empty).toMatchObject({ ok: false, kind: "failed" });
    const onError = vi.fn();
    const thrown = await completePlain(
      { prompt: "hi" },
      {
        complete: async () => {
          throw new Error("401 unauthorized");
        },
        slotId: () => 0,
        onError,
      },
    );
    expect(thrown).toEqual({ ok: false, reason: "401 unauthorized", kind: "failed" });
    expect(onError).toHaveBeenCalled();
  });

  it("aborts on the deadline and releases its pending controller", async () => {
    const pending = new Set<AbortController>();
    const complete: Complete = (params) =>
      new Promise((_, reject) => {
        params.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const result = await completePlain(
      { prompt: "hi" },
      { complete, slotId: () => 0, timeoutMs: 5, pending },
    );
    expect(result).toEqual({ ok: false, reason: "timed out", kind: "timeout" });
    expect(pending.size).toBe(0);
  });

  it("stops when the caller cancels", async () => {
    const caller = new AbortController();
    const complete: Complete = (params) =>
      new Promise((_, reject) => {
        params.signal.addEventListener("abort", () => reject(new Error("aborted")));
        caller.abort();
      });
    const result = await completePlain(
      { prompt: "hi", signal: caller.signal },
      { complete, slotId: () => 0 },
    );
    expect(result).toEqual({ ok: false, reason: "cancelled", kind: "cancelled" });
  });
});
