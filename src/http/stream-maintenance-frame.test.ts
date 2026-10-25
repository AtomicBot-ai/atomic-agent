import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../agent/agent-contract.js";
import { buildStreamEventHook } from "./openai-chat-completions.js";

/**
 * ATO-259 / ATO-295. Auto compaction and the packer's fallback cut run
 * inside an HTTP turn. The hook used to drop both, so the desktop showed
 * "Working…" for the whole summarization and never said history was left
 * out. They are named extension frames now; a plain OpenAI client sees
 * nothing new.
 */
describe("context maintenance over SSE", () => {
  const makeSse = () => {
    const written: Array<{ name: string | null; payload: unknown }> = [];
    return {
      written,
      writer: {
        closed: false,
        writeEvent(name: string | null, payload: unknown) {
          written.push({ name, payload });
        },
      },
    };
  };
  const env = (extensionsEnabled: boolean) =>
    ({
      completionId: "cmpl-1",
      created: 0,
      session: { id: "s1" },
      request: { model: "atomic-agent", extensionsEnabled },
    }) as never;
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const lifecycle: AgentLoopEvent[] = [
    { type: "compaction_started", sessionId: "s1", reason: "threshold", tokensBefore: 30_000 },
    { type: "compaction_progress", sessionId: "s1", chunk: 1, chunks: 2, completedChunks: 0, sourceTokens: 40_000 },
    {
      type: "compaction_completed", sessionId: "s1", usage, calls: 2,
      result: { status: "compacted", reason: "threshold", tokensBefore: 30_000, tokensAfter: 9_000, costUsd: 0.01 },
    },
  ];

  it("forwards the compaction lifecycle as named frames, counts only", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));
    lifecycle.forEach(hook);
    expect(sse.written).toEqual([
      { name: "compaction_started", payload: { object: "atomic.compaction_started", session_id: "s1", reason: "threshold", tokens_before: 30_000 } },
      { name: "compaction_progress", payload: { object: "atomic.compaction_progress", session_id: "s1", chunk: 1, chunks: 2, completed_chunks: 0 } },
      {
        name: "compaction_completed",
        payload: { object: "atomic.compaction_completed", session_id: "s1", status: "compacted", reason: "threshold", tokens_before: 30_000, tokens_after: 9_000 },
      },
    ]);
  });

  it("carries a failure's reason and a cancellation's status", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));
    hook({ type: "compaction_failed", sessionId: "s1", usage, calls: 1,
      result: { status: "failed", reason: "threshold", message: "summary was empty" } });
    hook({ type: "compaction_failed", sessionId: "s1", usage, calls: 0,
      result: { status: "cancelled", reason: "manual" } });
    expect(sse.written).toEqual([
      { name: "compaction_failed", payload: { object: "atomic.compaction_failed", session_id: "s1", status: "failed", reason: "threshold", message: "summary was empty" } },
      { name: "compaction_failed", payload: { object: "atomic.compaction_failed", session_id: "s1", status: "cancelled", reason: "manual" } },
    ]);
  });

  it("forwards the packer's cut", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));
    hook({ type: "history_trimmed", stepIndex: 3, droppedMessages: 12, droppedTurns: 2, boundBy: "pairs" });
    expect(sse.written).toEqual([
      { name: "history_trimmed", payload: { object: "atomic.history_trimmed", session_id: "s1", step_index: 3, dropped_messages: 12, dropped_turns: 2, bound_by: "pairs" } },
    ]);
  });

  it("ignores another session's compaction", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));
    hook({ type: "compaction_started", sessionId: "other", reason: "manual", tokensBefore: 1 });
    expect(sse.written).toEqual([]);
  });

  it("keeps the plain OpenAI stream unchanged", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(false));
    lifecycle.forEach(hook);
    hook({ type: "history_trimmed", stepIndex: 3, droppedMessages: 12, droppedTurns: 2, boundBy: "tokens" });
    expect(sse.written).toEqual([]);
  });
});
