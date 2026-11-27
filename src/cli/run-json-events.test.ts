import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../agent/agent-contract.js";
import type { SessionState } from "../session/session-state.js";
import {
  addTurnTokens,
  createRunJsonCursor,
  runUsage,
  runJsonEvent,
  runResultEvent,
  runStartEvent,
} from "./run-json-events.js";

/** ATO-2307: the lines `run --output-format stream-json` writes. */
describe("run JSON events", () => {
  const session = {
    id: "s-1",
    workingDir: "/work",
    status: "idle",
    turnCount: 2,
    stepCount: 5,
    lastError: null,
  } as unknown as SessionState;

  it("tags tool events with the step that started before them", () => {
    const cursor = createRunJsonCursor();
    expect(runJsonEvent({ type: "step_started", stepIndex: 3 }, cursor)).toBeNull();
    const call = {
      type: "llm_event",
      event: {
        type: "tool_call_parsed",
        call: { tool: "os.fs.read", args: { path: "a" } },
        batchIndex: 0,
        batchSize: 1,
      },
    } as unknown as AgentLoopEvent;
    expect(runJsonEvent(call, cursor)).toEqual({
      type: "tool_call",
      step: 3,
      tool: "os.fs.read",
      args: { path: "a" },
      batchIndex: 0,
    });
    const result = {
      type: "llm_event",
      event: {
        type: "tool_call_executed",
        result: { tool: "os.fs.read", status: "ok", summary: "read 1 line", details: {}, truncated: false },
        batchIndex: 0,
        batchSize: 1,
        durationMs: 12,
      },
    } as unknown as AgentLoopEvent;
    expect(runJsonEvent(result, cursor)).toEqual({
      type: "tool_result",
      step: 3,
      tool: "os.fs.read",
      status: "ok",
      summary: "read 1 line",
      truncated: false,
      batchIndex: 0,
      durationMs: 12,
    });
  });

  it("maps replies, step errors, turn ends and loop failures", () => {
    const cursor = createRunJsonCursor();
    const ev = (event: unknown) => runJsonEvent(event as AgentLoopEvent, cursor);
    expect(ev({ type: "llm_event", event: { type: "assistant_reply", text: "hi", progressNote: true } })).toEqual({
      type: "message",
      text: "hi",
      progress: true,
    });
    expect(
      ev({ type: "llm_event", event: { type: "step_error", category: "transport", error: new Error("down") } }),
    ).toEqual({ type: "error", fatal: false, step: null, category: "transport", message: "down" });
    expect(
      ev({ type: "turn_finished", turnIndex: 1, reason: "reply", stepCount: 2, durationMs: 40 }),
    ).toEqual({ type: "turn_finished", turn: 1, reason: "reply", steps: 2, durationMs: 40 });
    expect(ev({ type: "loop_failed", category: "grammar", error: new Error("bad") })).toEqual({
      type: "error",
      fatal: true,
      category: "grammar",
      message: "bad",
    });
    expect(ev({ type: "user_message", text: "x" })).toBeNull();
  });

  it("opens with the chat and pin, and closes with the result object", () => {
    expect(runStartEvent({ session, resumed: true, providerId: "openai", model: "gpt-5" })).toEqual({
      type: "start",
      sessionId: "s-1",
      cwd: "/work",
      resumed: true,
      providerId: "openai",
      model: "gpt-5",
    });
    expect(runResultEvent({ session, reply: "done", durationMs: 99, isError: false })).toEqual({
      type: "result",
      isError: false,
      sessionId: "s-1",
      status: "idle",
      result: "done",
      turns: 2,
      steps: 5,
      durationMs: 99,
      lastError: null,
      usage: null,
    });
  });

  it("adds the run's tokens and the schema outcome to the result (ATO-2440)", () => {
    const tokens = addTurnTokens(addTurnTokens(null, { promptTokens: 10, completionTokens: 2 }), {
      promptTokens: 5,
      completionTokens: 1,
    });
    expect(addTurnTokens(tokens, undefined)).toEqual({ promptTokens: 15, completionTokens: 3 });
    const withSpend = { ...session, sessionUsage: { costUsd: 0.5 } } as unknown as SessionState;
    expect(
      runResultEvent({
        session: withSpend,
        reply: "x",
        durationMs: 1,
        isError: true,
        tokens,
        schemaError: "the answer is not JSON",
      }),
    ).toMatchObject({
      usage: { costUsd: 0.5, promptTokens: 15, completionTokens: 3 },
      schemaError: "the answer is not JSON",
    });
    expect(runUsage(withSpend, null)).toEqual({ costUsd: 0.5, promptTokens: null, completionTokens: null });
    expect(
      runResultEvent({ session, reply: "{}", durationMs: 1, isError: false, structuredOutput: {} }),
    ).toMatchObject({ structuredOutput: {} });
  });
});
