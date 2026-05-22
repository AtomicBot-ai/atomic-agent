import { describe, expect, it, vi } from "vitest";

import type { CompletionResult } from "../../llm/llama-server-client.js";

import {
  REWRITER_SLOT_ID,
  type RewriterLlmComplete,
  createQueryRewriterRunner,
} from "./query-rewriter-runner.js";
import { createAlwaysGate } from "./rewriter-gate.js";
import type { RewriterGate } from "./rewriter-gate.js";

function completion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: {} as never,
    cacheHitTokens: 0,
    slotId: REWRITER_SLOT_ID,
    modelId: null,
  } as CompletionResult;
}

function envelope(body: string): string {
  return `<rewritten_query>${body}</rewritten_query>`;
}

describe("createQueryRewriterRunner", () => {
  it("skips the LLM when there is no history (skipped_no_history)", async () => {
    const llm = vi.fn();
    const runner = createQueryRewriterRunner({
      llmComplete: llm as unknown as RewriterLlmComplete,
      timeoutMs: 1000,
    });
    const out = await runner.maybeRewrite({
      sessionId: "s",
      userMessage: "what about it",
      history: [],
      signal: new AbortController().signal,
    });
    expect(out).toBe("what about it");
    expect(llm).not.toHaveBeenCalled();
  });

  it("skips the LLM when the message is not referential (skipped_not_referential)", async () => {
    const llm = vi.fn();
    const runner = createQueryRewriterRunner({
      llmComplete: llm as unknown as RewriterLlmComplete,
      timeoutMs: 1000,
    });
    const out = await runner.maybeRewrite({
      sessionId: "s",
      userMessage:
        "please walk me through the BM25 ranking algorithm in detail",
      history: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
      signal: new AbortController().signal,
    });
    expect(out).toBe(
      "please walk me through the BM25 ranking algorithm in detail",
    );
    expect(llm).not.toHaveBeenCalled();
  });

  it("calls the LLM with slotId=-1 (load-bearing invariant)", async () => {
    let capturedSlot = NaN;
    const llm: RewriterLlmComplete = async (p) => {
      capturedSlot = p.slotId;
      return completion(envelope("FTS5 ranking details"));
    };
    const runner = createQueryRewriterRunner({
      llmComplete: llm,
      timeoutMs: 1000,
    });
    const out = await runner.maybeRewrite({
      sessionId: "s",
      userMessage: "and what about it",
      history: [
        { role: "user", text: "what is BM25" },
        { role: "assistant", text: "ranking algorithm used by FTS5" },
      ],
      signal: new AbortController().signal,
    });
    expect(capturedSlot).toBe(-1);
    expect(out).toBe("FTS5 ranking details");
  });

  it("falls back to the raw message on parse failure (no envelope)", async () => {
    const llm: RewriterLlmComplete = async () =>
      completion("raw text without an envelope");
    const runner = createQueryRewriterRunner({
      llmComplete: llm,
      timeoutMs: 1000,
    });
    const out = await runner.maybeRewrite({
      sessionId: "s",
      userMessage: "and what about it",
      history: [
        { role: "user", text: "u1" },
        { role: "assistant", text: "a1" },
      ],
      signal: new AbortController().signal,
    });
    expect(out).toBe("and what about it");
  });

  it("falls back to the raw message when the LLM throws", async () => {
    const llm: RewriterLlmComplete = async () => {
      throw new Error("network down");
    };
    const runner = createQueryRewriterRunner({
      llmComplete: llm,
      timeoutMs: 1000,
    });
    const out = await runner.maybeRewrite({
      sessionId: "s",
      userMessage: "и ещё про это",
      history: [
        { role: "user", text: "u1" },
        { role: "assistant", text: "a1" },
      ],
      signal: new AbortController().signal,
    });
    expect(out).toBe("и ещё про это");
  });

  it("times out and returns the raw message", async () => {
    // Never resolves — the runner's hard timeout must fire.
    const llm: RewriterLlmComplete = () =>
      new Promise<CompletionResult>(() => {
        // intentionally pending
      });
    const runner = createQueryRewriterRunner({
      llmComplete: llm,
      timeoutMs: 10,
    });
    const out = await runner.maybeRewrite({
      sessionId: "s",
      userMessage: "и ещё про это",
      history: [
        { role: "user", text: "u1" },
        { role: "assistant", text: "a1" },
      ],
      signal: new AbortController().signal,
    });
    expect(out).toBe("и ещё про это");
  });

  it("respects an upstream aborted signal at entry", async () => {
    const ac = new AbortController();
    ac.abort();
    const llm = vi.fn();
    const runner = createQueryRewriterRunner({
      llmComplete: llm as unknown as RewriterLlmComplete,
      timeoutMs: 1000,
    });
    const out = await runner.maybeRewrite({
      sessionId: "s",
      userMessage: "и про это",
      history: [
        { role: "user", text: "u" },
        { role: "assistant", text: "a" },
      ],
      signal: ac.signal,
    });
    expect(out).toBe("и про это");
    expect(llm).not.toHaveBeenCalled();
  });

  it("fires the LLM when an always gate is injected", async () => {
    const llm = vi.fn(async () => completion(envelope("expanded query")));
    const runner = createQueryRewriterRunner({
      llmComplete: llm as unknown as RewriterLlmComplete,
      timeoutMs: 1000,
      gate: createAlwaysGate(),
    });
    const out = await runner.maybeRewrite({
      sessionId: "s",
      userMessage:
        "please walk me through the BM25 ranking algorithm in detail",
      history: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
      signal: new AbortController().signal,
    });
    expect(out).toBe("expanded query");
    expect(llm).toHaveBeenCalledOnce();
  });

  it("skips when an injected gate returns false", async () => {
    const neverGate: RewriterGate = {
      name: "heuristic",
      async check() {
        return false;
      },
    };
    const llm = vi.fn();
    const runner = createQueryRewriterRunner({
      llmComplete: llm as unknown as RewriterLlmComplete,
      timeoutMs: 1000,
      gate: neverGate,
    });
    const out = await runner.maybeRewrite({
      sessionId: "s",
      userMessage: "and what about it",
      history: [
        { role: "user", text: "u1" },
        { role: "assistant", text: "a1" },
      ],
      signal: new AbortController().signal,
    });
    expect(out).toBe("and what about it");
    expect(llm).not.toHaveBeenCalled();
  });

  it("falls back to the raw message when the model abstains (NONE)", async () => {
    const llm: RewriterLlmComplete = async () => completion(envelope("NONE"));
    const runner = createQueryRewriterRunner({
      llmComplete: llm,
      timeoutMs: 1000,
    });
    const out = await runner.maybeRewrite({
      sessionId: "s",
      userMessage: "и что насчёт этого",
      history: [
        { role: "user", text: "u" },
        { role: "assistant", text: "a" },
      ],
      signal: new AbortController().signal,
    });
    expect(out).toBe("и что насчёт этого");
  });
});
