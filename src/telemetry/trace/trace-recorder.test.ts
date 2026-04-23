import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../../agent/agent-loop.js";

import { createTraceRecorder } from "./trace-recorder.js";
import type { TraceEvent } from "./trace-event.js";

function collector(): {
  events: TraceEvent[];
  emit: (event: TraceEvent) => void;
} {
  const events: TraceEvent[] = [];
  return { events, emit: (event) => events.push(event) };
}

describe("createTraceRecorder", () => {
  const now = (): number => 1000;

  it("emits session_started with monotonic seq starting at 0", () => {
    const { events, emit } = collector();
    const rec = createTraceRecorder({ sessionId: "s-1", emit, now });
    rec.beginSession({ workingDir: "/w", metadata: { source: "cli" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "session_started",
      sessionId: "s-1",
      seq: 0,
      ts: 1000,
      workingDir: "/w",
      metadata: { source: "cli" },
    });
  });

  it("attaches user_message to the next turn_started", () => {
    const { events, emit } = collector();
    const rec = createTraceRecorder({ sessionId: "s-2", emit, now });
    rec.onAgentEvent({ type: "user_message", text: "hello" });
    rec.onAgentEvent({ type: "turn_started", turnIndex: 0 });
    const turn = events.find((e) => e.type === "turn_started");
    expect(turn).toMatchObject({
      type: "turn_started",
      turnIndex: 0,
      userMessage: "hello",
    });
  });

  it("pairs tool_call_parsed + tool_call_executed into tool_invocation", () => {
    const { events, emit } = collector();
    const rec = createTraceRecorder({ sessionId: "s-3", emit, now });
    rec.onAgentEvent({ type: "turn_started", turnIndex: 0 });
    rec.onAgentEvent({ type: "step_started", stepIndex: 0 });
    rec.onAgentEvent({
      type: "llm_event",
      event: {
        type: "tool_call_parsed",
        call: { tool: "shell.run", args: { command: "ls" } },
      },
    });
    rec.onAgentEvent({
      type: "llm_event",
      event: {
        type: "tool_call_executed",
        result: {
          tool: "shell.run",
          status: "ok",
          summary: "listed 3 files",
          details: { exitCode: 0 },
          truncated: false,
        },
      },
    });
    const invocation = events.find((e) => e.type === "tool_invocation");
    expect(invocation).toMatchObject({
      type: "tool_invocation",
      tool: "shell.run",
      args: { command: "ls" },
      status: "ok",
      summary: "listed 3 files",
      details: { exitCode: 0 },
      turnIndex: 0,
      stepIndex: 0,
    });
  });

  it("forwards prompt_captured verbatim", () => {
    const { events, emit } = collector();
    const rec = createTraceRecorder({ sessionId: "s-4", emit, now });
    rec.onAgentEvent({ type: "turn_started", turnIndex: 0 });
    rec.onAgentEvent({ type: "step_started", stepIndex: 0 });
    rec.onAgentEvent({
      type: "llm_event",
      event: {
        type: "prompt_captured",
        stepIndex: 0,
        stablePrefixHash: "abc123",
        tail: "### conversation\nhi",
        tokens: { total: 100, stablePrefix: 80, tail: 20 },
        slotId: 1,
        cacheReused: true,
      },
    });
    const captured = events.find((e) => e.type === "prompt_captured");
    expect(captured).toMatchObject({
      type: "prompt_captured",
      stablePrefixHash: "abc123",
      tail: "### conversation\nhi",
      tokens: { total: 100, stablePrefix: 80, tail: 20 },
      slotId: 1,
      cacheReused: true,
      turnIndex: 0,
      stepIndex: 0,
    });
  });

  it("forwards llm_raw_completion with attempt", () => {
    const { events, emit } = collector();
    const rec = createTraceRecorder({ sessionId: "s-5", emit, now });
    rec.onAgentEvent({ type: "turn_started", turnIndex: 0 });
    rec.onAgentEvent({ type: "step_started", stepIndex: 0 });
    rec.onAgentEvent({
      type: "llm_event",
      event: {
        type: "llm_raw_completion",
        stepIndex: 0,
        attempt: 2,
        completion: {
          content: '{"tool":"reply"}',
          reasoningContent: "thought",
          stop: true,
          truncated: false,
          timing: {
            promptMs: 5,
            predictedMs: 12,
            promptTokens: 80,
            predictedTokens: 6,
          },
          cacheHitTokens: 80,
          slotId: 0,
          modelId: "demo",
        },
      },
    });
    const completion = events.find((e) => e.type === "llm_completion");
    expect(completion).toMatchObject({
      type: "llm_completion",
      attempt: 2,
      content: '{"tool":"reply"}',
      reasoningContent: "thought",
      cacheHitTokens: 80,
      modelId: "demo",
      stop: true,
      truncated: false,
    });
  });

  it("emits parse_retry and error events", () => {
    const { events, emit } = collector();
    const rec = createTraceRecorder({ sessionId: "s-6", emit, now });
    rec.onAgentEvent({ type: "turn_started", turnIndex: 0 });
    rec.onAgentEvent({ type: "step_started", stepIndex: 1 });
    rec.onAgentEvent({
      type: "llm_event",
      event: {
        type: "parse_retry",
        stepIndex: 1,
        attempt: 1,
        reason: "unexpected token",
      },
    });
    rec.onAgentEvent({
      type: "llm_event",
      event: { type: "step_error", error: new Error("boom") },
    });
    expect(events.some((e) => e.type === "parse_retry")).toBe(true);
    const err = events.find((e) => e.type === "error");
    expect(err).toMatchObject({ type: "error", message: "boom" });
  });

  it("maps loop_detected and loop_failed", () => {
    const { events, emit } = collector();
    const rec = createTraceRecorder({ sessionId: "s-7", emit, now });
    rec.onAgentEvent({ type: "turn_started", turnIndex: 0 });
    rec.onAgentEvent({
      type: "loop_detected",
      tool: "fs.read",
      count: 3,
      stepIndex: 2,
    });
    rec.onAgentEvent({
      type: "loop_failed",
      error: new Error("loop blew up"),
    });
    expect(events.some((e) => e.type === "loop_detected")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("ignores noisy events (reasoning_delta, assistant_delta, llm_completed)", () => {
    const { events, emit } = collector();
    const rec = createTraceRecorder({ sessionId: "s-8", emit, now });
    rec.onAgentEvent({ type: "turn_started", turnIndex: 0 });
    rec.onAgentEvent({ type: "step_started", stepIndex: 0 });
    const ignored: AgentLoopEvent[] = [
      {
        type: "llm_event",
        event: { type: "reasoning_delta", stepIndex: 0, text: "..." },
      },
      {
        type: "llm_event",
        event: { type: "assistant_delta", text: "..." },
      },
      {
        type: "llm_event",
        event: {
          type: "prompt_built",
          prompt: {
            text: "",
            stablePrefix: "",
            tail: "",
            tokens: { total: 0, stablePrefix: 0, tail: 0 },
            truncated: { session: false, worldSnapshot: false, conversation: false },
          } as never,
          slotId: 0,
        },
      },
    ];
    for (const ev of ignored) rec.onAgentEvent(ev);
    expect(events.filter((e) => e.type === "prompt_captured")).toHaveLength(0);
    expect(events.filter((e) => e.type === "llm_completion")).toHaveLength(0);
  });

  it("assigns monotonic seq across events", () => {
    const { events, emit } = collector();
    const rec = createTraceRecorder({ sessionId: "s-9", emit, now });
    rec.beginSession({ workingDir: "/w" });
    rec.onAgentEvent({ type: "turn_started", turnIndex: 0 });
    rec.onAgentEvent({ type: "step_started", stepIndex: 0 });
    rec.onAgentEvent({
      type: "step_finished",
      stepIndex: 0,
      summary: "ok",
      durationMs: 10,
    });
    rec.onAgentEvent({
      type: "turn_finished",
      turnIndex: 0,
      reason: "reply",
      stepCount: 1,
      durationMs: 20,
    });
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
  });
});
