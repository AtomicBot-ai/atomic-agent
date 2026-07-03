import { describe, expect, it } from "vitest";

import type { CompressedToolResult } from "../compressor/result-compressor.js";
import { createAgentEventForwarder } from "./event-forwarder.js";
import type { EventType } from "./protocol/index.js";

interface Emitted {
  type: EventType;
  payload: Record<string, unknown>;
  correlationId?: string;
}

function fakeProtocol() {
  const events: Emitted[] = [];
  const protocol = {
    emitEvent(type: EventType, payload: unknown, correlationId?: string) {
      events.push({
        type,
        payload: payload as Record<string, unknown>,
        ...(correlationId !== undefined ? { correlationId } : {}),
      });
      return undefined as never;
    },
  };
  // The forwarder only ever calls `emitEvent`.
  return { events, protocol: protocol as never };
}

describe("createAgentEventForwarder", () => {
  it("tags every event with sessionId and the chat.send correlationId", () => {
    const { events, protocol } = fakeProtocol();
    const forward = createAgentEventForwarder(protocol)("s-1", "req-9");
    forward({ type: "turn_started", turnIndex: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "turn.started",
      correlationId: "req-9",
      payload: { sessionId: "s-1", turnIndex: 0 },
    });
  });

  it("maps loop_detected verbatim including optional severity", () => {
    const { events, protocol } = fakeProtocol();
    const forward = createAgentEventForwarder(protocol)("s-1");
    forward({
      type: "loop_detected",
      tool: "os.fs.read",
      count: 4,
      stepIndex: 2,
      level: "critical",
      detector: "no_progress",
    });
    expect(events[0]).toMatchObject({
      type: "loop.detected",
      payload: {
        sessionId: "s-1",
        tool: "os.fs.read",
        count: 4,
        stepIndex: 2,
        level: "critical",
        detector: "no_progress",
      },
    });
  });

  it("forwards loop_completed only for finish / max_steps", () => {
    const { events, protocol } = fakeProtocol();
    const forward = createAgentEventForwarder(protocol)("s-1");
    forward({ type: "loop_completed", reason: "reply" });
    expect(events).toHaveLength(0);
    forward({ type: "loop_completed", reason: "finish" });
    expect(events).toEqual([
      expect.objectContaining({
        type: "session.completed",
        payload: { sessionId: "s-1", reason: "finish" },
      }),
    ]);
  });

  it("maps loop_failed to session.failed with the failure category", () => {
    const { events, protocol } = fakeProtocol();
    const forward = createAgentEventForwarder(protocol)("s-1");
    forward({
      type: "loop_failed",
      error: new Error("boom"),
      category: "transport",
    });
    expect(events[0]).toMatchObject({
      type: "session.failed",
      payload: { sessionId: "s-1", error: "boom", category: "transport" },
    });
  });

  it("streams assistant + reasoning deltas from nested llm_event", () => {
    const { events, protocol } = fakeProtocol();
    const forward = createAgentEventForwarder(protocol)("s-1", "req-1");
    forward({
      type: "llm_event",
      event: { type: "reasoning_delta", stepIndex: 0, text: "hmm" },
    });
    forward({
      type: "llm_event",
      event: { type: "assistant_delta", text: "hel" },
    });
    forward({
      type: "llm_event",
      event: { type: "assistant_reply", text: "hello" },
    });
    expect(events.map((e) => e.type)).toEqual([
      "reasoning.delta",
      "assistant.delta",
      "assistant.reply",
    ]);
    expect(events[2]?.payload).toEqual({ sessionId: "s-1", text: "hello" });
  });

  it("carries batch index/size only for multi-call tool steps", () => {
    const { events, protocol } = fakeProtocol();
    const forward = createAgentEventForwarder(protocol)("s-1");
    const result: CompressedToolResult = {
      tool: "os.fs.read",
      status: "ok",
      summary: "read ok",
      truncated: false,
    } as CompressedToolResult;
    forward({
      type: "llm_event",
      event: { type: "tool_call_executed", result, batchIndex: 1, batchSize: 3 },
    });
    forward({
      type: "llm_event",
      event: {
        type: "tool_call_executed",
        result,
        batchIndex: 0,
        batchSize: 1,
      },
    });
    expect(events[0]?.payload).toMatchObject({ batchIndex: 1, batchSize: 3 });
    expect(events[1]?.payload).not.toHaveProperty("batchIndex");
  });

  it("maps step_error to a top-level error event with the category code", () => {
    const { events, protocol } = fakeProtocol();
    const forward = createAgentEventForwarder(protocol)("s-1");
    forward({
      type: "llm_event",
      event: {
        type: "step_error",
        error: new Error("nope"),
        category: "grammar",
      },
    });
    expect(events[0]).toMatchObject({
      type: "error",
      payload: { message: "nope", code: "step_error:grammar" },
    });
  });

  it("drops internal-only step variants (prompt_built, llm_completed)", () => {
    const { events, protocol } = fakeProtocol();
    const forward = createAgentEventForwarder(protocol)("s-1");
    forward({
      type: "llm_event",
      event: { type: "llm_completed", completion: {} as never },
    });
    expect(events).toHaveLength(0);
  });
});
