import { describe, expect, it } from "vitest";

import { AG_UI_PROTOCOL_VERSION, createAgUiTranslator, type AgUiEvent } from "./ag-ui-events.js";

/** ATO-694: the agent loop's events as AG-UI events. */
function makeTranslator() {
  const events: AgUiEvent[] = [];
  let n = 0;
  const translator = createAgUiTranslator({
    threadId: "thread-1",
    runId: "run-1",
    emit: (event) => events.push(event),
    newId: () => `m${++n}`,
    now: () => 1000,
  });
  const feed = (event: unknown) => translator.onEvent(event as never);
  const llm = (event: unknown) => feed({ type: "llm_event", event });
  const types = () => events.map((e) => e.type);
  return { translator, events, feed, llm, types };
}

describe("AG-UI translator", () => {
  it("opens the run with the thread, the run and the protocol version", () => {
    const { translator, events } = makeTranslator();
    translator.runStarted();
    expect(events).toEqual([
      { type: "RUN_STARTED", threadId: "thread-1", runId: "run-1", protocolVersion: AG_UI_PROTOCOL_VERSION, timestamp: 1000 },
    ]);
  });

  it("streams a reply as one text message inside a step, without writing the body twice", () => {
    const { translator, events, feed, llm, types } = makeTranslator();
    translator.runStarted();
    feed({ type: "step_started", stepIndex: 0 });
    llm({ type: "assistant_delta", text: "Hel" });
    llm({ type: "assistant_delta", text: "lo" });
    llm({ type: "assistant_reply", text: "Hello" });
    feed({ type: "step_finished", stepIndex: 0, summary: "", durationMs: 1 });
    translator.finished({ reason: "finish", usage: { promptTokens: 5, completionTokens: 3 } } as never);
    expect(types()).toEqual([
      "RUN_STARTED",
      "STEP_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "STEP_FINISHED",
      "RUN_FINISHED",
    ]);
    expect(events[1]).toMatchObject({ stepName: "step-0" });
    expect(events[2]).toMatchObject({ messageId: "m1", role: "assistant" });
    expect(events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e["delta"])).toEqual(["Hel", "lo"]);
    expect(events.at(-1)).toMatchObject({
      threadId: "thread-1",
      runId: "run-1",
      outcome: { type: "success" },
      usage: [{ inputTokens: 5, outputTokens: 3, totalTokens: 8 }],
    });
  });

  it("sends a reply that was never streamed whole, and only the rest of a half-streamed one", () => {
    const whole = makeTranslator();
    whole.feed({ type: "step_started", stepIndex: 0 });
    whole.llm({ type: "assistant_reply", text: "Stopped after 30 steps." });
    expect(whole.events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e["delta"])).toEqual([
      "Stopped after 30 steps.",
    ]);
    expect(whole.types()).toContain("TEXT_MESSAGE_END");

    const half = makeTranslator();
    half.feed({ type: "step_started", stepIndex: 0 });
    half.llm({ type: "assistant_delta", text: "Done: " });
    half.llm({ type: "assistant_reply", text: "Done: 3 files" });
    expect(half.events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e["delta"])).toEqual([
      "Done: ",
      "3 files",
    ]);
  });

  it("tells a polished reply that already streamed as a CUSTOM event on the same message", () => {
    const { events, feed, llm } = makeTranslator();
    feed({ type: "step_started", stepIndex: 0 });
    llm({ type: "assistant_delta", text: "raw text" });
    llm({ type: "assistant_reply", text: "Polished text", rawText: "raw text" });
    expect(events.find((e) => e.type === "CUSTOM")).toMatchObject({
      name: "atomic.reply_polished",
      value: { messageId: "m1", text: "Polished text" },
    });
  });

  it("maps a tool call to START / ARGS / END and its outcome to TOOL_CALL_RESULT", () => {
    const { events, feed, llm, types } = makeTranslator();
    feed({ type: "step_started", stepIndex: 2 });
    llm({ type: "assistant_delta", text: "Let me look." });
    llm({ type: "tool_call_parsed", call: { tool: "fs.read", args: { path: "a.ts" } }, batchIndex: 0, batchSize: 1 });
    llm({
      type: "tool_call_executed",
      result: { tool: "fs.read", status: "ok", summary: "12 lines" },
      batchIndex: 0,
      batchSize: 1,
      durationMs: 41.6,
    });
    expect(types()).toEqual([
      "STEP_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
    ]);
    const start = events.find((e) => e.type === "TOOL_CALL_START")!;
    expect(start).toMatchObject({ toolCallId: "run-1:2:0", toolCallName: "fs.read", parentMessageId: "m1" });
    expect(events.find((e) => e.type === "TOOL_CALL_ARGS")).toMatchObject({
      toolCallId: "run-1:2:0",
      delta: JSON.stringify({ path: "a.ts" }),
    });
    expect(events.find((e) => e.type === "TOOL_CALL_RESULT")).toMatchObject({
      toolCallId: "run-1:2:0",
      role: "tool",
      content: "12 lines",
      metadata: { status: "ok", durationMs: 42 },
    });
  });

  it("says a denied call is denied", () => {
    const { events, feed, llm } = makeTranslator();
    feed({ type: "step_started", stepIndex: 0 });
    llm({ type: "tool_call_parsed", call: { tool: "os.shell", args: {} }, batchIndex: 0, batchSize: 1 });
    llm({
      type: "tool_call_executed",
      result: { tool: "os.shell", status: "error", summary: "denied", details: { approvalDenied: true } },
      batchIndex: 0,
      batchSize: 1,
    });
    expect(events.find((e) => e.type === "TOOL_CALL_RESULT")).toMatchObject({ metadata: { status: "denied" } });
  });

  it("does not show reply and finish as tool calls", () => {
    const { feed, llm, types } = makeTranslator();
    feed({ type: "step_started", stepIndex: 0 });
    llm({ type: "tool_call_parsed", call: { tool: "reply", args: { text: "hi" } }, batchIndex: 0, batchSize: 1 });
    llm({
      type: "tool_call_executed",
      result: { tool: "reply", status: "ok", summary: "" },
      batchIndex: 0,
      batchSize: 1,
    });
    expect(types()).toEqual(["STEP_STARTED"]);
  });

  it("streams reasoning as its own message and closes it when the answer starts", () => {
    const { events, feed, llm, types } = makeTranslator();
    feed({ type: "step_started", stepIndex: 0 });
    llm({ type: "reasoning_delta", stepIndex: 0, text: "thinking" });
    llm({ type: "assistant_delta", text: "Answer" });
    expect(types()).toEqual([
      "STEP_STARTED",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
    ]);
    expect(events[2]).toMatchObject({ role: "reasoning", messageId: "m1" });
    expect(events[6]).toMatchObject({ messageId: "m2" });
  });

  it("sends the plan as a STATE_SNAPSHOT", () => {
    const { events, llm } = makeTranslator();
    llm({
      type: "plan_updated",
      stepIndex: 1,
      plan: { items: [{ step: "a", status: "done" }], updatedAt: 7 },
    });
    expect(events).toEqual([
      { type: "STATE_SNAPSHOT", snapshot: { plan: { items: [{ step: "a", status: "done" }], updatedAt: 7 } }, timestamp: 1000 },
    ]);
  });

  it("sends a provider wait as a CUSTOM atomic event", () => {
    const { events, feed } = makeTranslator();
    feed({ type: "provider_waiting", attempt: 2, waitedMs: 5, maxWaitMs: 60, nextRetryMs: 10, reason: "429" });
    expect(events[0]).toMatchObject({
      type: "CUSTOM",
      name: "atomic.provider_waiting",
      value: { attempt: 2, waitedMs: 5, maxWaitMs: 60, nextRetryMs: 10, reason: "429" },
    });
  });

  it("ends a failed run with RUN_ERROR carrying the loop's own failure, after closing open messages", () => {
    const { translator, events, feed, llm, types } = makeTranslator();
    feed({ type: "step_started", stepIndex: 0 });
    llm({ type: "assistant_delta", text: "partial" });
    feed({ type: "loop_failed", error: new Error("provider down"), category: "network" });
    translator.failed("Agent loop failed: provider down");
    expect(types()).toEqual(["STEP_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "STEP_FINISHED", "RUN_ERROR"]);
    expect(events.at(-1)).toMatchObject({ message: "provider down", code: "network" });
    // Nothing after the end of the run.
    llm({ type: "assistant_delta", text: "late" });
    translator.finished({ reason: "finish" } as never);
    expect(events.at(-1)!.type).toBe("RUN_ERROR");
  });

  it("reports a stopped turn as a cancelled outcome", () => {
    const { translator, events } = makeTranslator();
    translator.finished({ reason: "cancelled" } as never);
    expect(events).toEqual([
      { type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1", outcome: { type: "cancelled" }, timestamp: 1000 },
    ]);
  });
});
