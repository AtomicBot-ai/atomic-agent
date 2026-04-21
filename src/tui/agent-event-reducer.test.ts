import { describe, expect, it } from "vitest";
import { reduceTuiState, type TuiAction } from "./agent-event-reducer.js";
import {
  canAcceptMessage,
  createInitialTuiState,
  DEFAULT_RING_BUFFER_SIZE,
  type TuiSessionInfo,
  type TuiState,
} from "./tui-state.js";

function fakeSession(overrides: Partial<TuiSessionInfo> = {}): TuiSessionInfo {
  return {
    sessionId: null,
    workingDir: "/tmp",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chrome",
    browserHeadless: false,
    approvalRequired: false,
    maxSteps: 10,
    skillCount: 0,
    ...overrides,
  };
}

function apply(state: TuiState, actions: TuiAction[]): TuiState {
  return actions.reduce(reduceTuiState, state);
}

describe("reduceTuiState", () => {
  it("should transition to running when step_started arrives", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = reduceTuiState(initial, {
      type: "agent_event",
      event: { type: "step_started", stepIndex: 0 },
    });
    expect(next.status).toBe("running");
    expect(next.currentStep).toBe(0);
    expect(next.stepStartedAt).not.toBeNull();
    expect(next.feed).toHaveLength(1);
    expect(next.feed[0]?.kind).toBe("step_started");
  });

  it("should record tool execution result and update latestResult", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "agent_event", event: { type: "step_started", stepIndex: 0 } },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: {
            type: "tool_call_executed",
            result: {
              tool: "browser.navigate",
              status: "ok",
              summary: "navigated to https://calendar.google.com",
              truncated: false,
            },
          },
        },
      },
    ]);
    expect(next.latestResult?.tool).toBe("browser.navigate");
    expect(next.latestResult?.status).toBe("ok");
    expect(next.metrics.toolsOk).toBe(1);
    expect(next.metrics.toolsError).toBe(0);
  });

  it("should enter awaiting_approval state on approval request", () => {
    const initial = createInitialTuiState(fakeSession());
    const request = {
      approvalId: "a-1",
      sessionId: "s-1",
      tool: "os.shell.exec",
      reason: "dangerous shell command",
      preview: "rm -rf /tmp/x",
    };
    const next = reduceTuiState(initial, { type: "approval_requested", request });
    expect(next.status).toBe("awaiting_approval");
    expect(next.pendingApproval?.approvalId).toBe("a-1");
  });

  it("should clear pending approval after resolve and restore running", () => {
    const initial = createInitialTuiState(fakeSession());
    const request = {
      approvalId: "a-1",
      sessionId: "s-1",
      tool: "os.fs.write",
      reason: "fs write",
    };
    const next = apply(initial, [
      { type: "approval_requested", request },
      { type: "approval_resolved", approvalId: "a-1", approved: true },
    ]);
    expect(next.pendingApproval).toBeNull();
    expect(next.status).toBe("running");
  });

  it("should ignore resolve for unknown approvalId", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = reduceTuiState(initial, {
      type: "approval_resolved",
      approvalId: "ghost",
      approved: true,
    });
    expect(next).toBe(initial);
  });

  it("should track cache hits and token totals from metrics", () => {
    const initial = createInitialTuiState(fakeSession());
    const ts = Date.now();
    const next = apply(initial, [
      { type: "metric", sample: { name: "llm.prompt_tokens", value: 2400, timestamp: ts } },
      { type: "metric", sample: { name: "llm.completion_tokens", value: 32, timestamp: ts } },
      { type: "metric", sample: { name: "llm.duration_ms", value: 850, timestamp: ts } },
      { type: "metric", sample: { name: "llm.cache_reused", value: 1, timestamp: ts } },
      { type: "metric", sample: { name: "llm.cache_reused", value: 0, timestamp: ts } },
    ]);
    expect(next.metrics.promptTokensLast).toBe(2400);
    expect(next.metrics.completionTokensLast).toBe(32);
    expect(next.metrics.llmDurationMsLast).toBe(850);
    expect(next.metrics.totalTokens).toBe(2432);
    expect(next.metrics.kvCacheHits).toBe(1);
    expect(next.metrics.kvCacheMisses).toBe(1);
  });

  it("should return to idle and archive run on loop_completed with finish", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "agent_event", event: { type: "user_message", text: "check email" } },
      { type: "message_submitted", message: "check email" },
      { type: "agent_event", event: { type: "step_started", stepIndex: 0 } },
      { type: "agent_event", event: { type: "loop_completed", reason: "finish" } },
    ]);
    expect(next.status).toBe("idle");
    expect(next.lastRunStatus).toBe("completed: finish");
    expect(next.runHistory).toHaveLength(1);
    expect(next.runHistory[0]?.outcome).toBe("completed");
    expect(next.runHistory[0]?.message).toBe("check email");
  });

  it("should return to idle and archive run as cancelled on abort", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "message_submitted", message: "whatever" },
      { type: "agent_event", event: { type: "loop_completed", reason: "cancelled" } },
    ]);
    expect(next.status).toBe("idle");
    expect(next.runHistory[0]?.outcome).toBe("cancelled");
  });

  it("should return to idle and archive run as failed on loop_failed", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "message_submitted", message: "boom test" },
      { type: "agent_event", event: { type: "loop_failed", error: new Error("boom") } },
    ]);
    expect(next.status).toBe("idle");
    expect(next.lastRunStatus).toBe("failed: boom");
    expect(next.runHistory[0]?.outcome).toBe("failed");
    expect(next.runHistory[0]?.reason).toBe("boom");
  });

  it("should cap feed ring buffer to configured size", () => {
    const initial = createInitialTuiState(fakeSession(), 3);
    const actions: TuiAction[] = Array.from({ length: 10 }).map((_, i) => ({
      type: "agent_event",
      event: { type: "step_started", stepIndex: i },
    }));
    const next = apply(initial, actions);
    expect(next.feed).toHaveLength(3);
    expect(next.feed[0]?.line).toBe("[step 7] started");
    expect(next.feed[2]?.line).toBe("[step 9] started");
  });

  it("should cap logs ring buffer", () => {
    const initial = createInitialTuiState(fakeSession(), 2);
    const ts = Date.now();
    const next = apply(initial, [
      { type: "log", record: { level: "info", message: "a", timestamp: ts } },
      { type: "log", record: { level: "info", message: "b", timestamp: ts } },
      { type: "log", record: { level: "info", message: "c", timestamp: ts } },
    ]);
    expect(next.logs).toHaveLength(2);
    expect(next.logs[0]?.message).toBe("b");
    expect(next.logs[1]?.message).toBe("c");
  });

  it("should switch active tab", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = reduceTuiState(initial, { type: "tab_changed", tab: "logs" });
    expect(next.activeTab).toBe("logs");
  });

  it("should use DEFAULT_RING_BUFFER_SIZE when not provided", () => {
    const initial = createInitialTuiState(fakeSession());
    expect(initial.ringBufferSize).toBe(DEFAULT_RING_BUFFER_SIZE);
  });
});

describe("chat loop", () => {
  it("should update inputValue on input_changed", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = reduceTuiState(initial, { type: "input_changed", value: "open gmail" });
    expect(next.inputValue).toBe("open gmail");
  });

  it("should start with an empty inputValue", () => {
    const initial = createInitialTuiState(fakeSession());
    expect(initial.inputValue).toBe("");
  });

  it("should accept a new message only when idle", () => {
    const initial = createInitialTuiState(fakeSession());
    expect(canAcceptMessage(initial)).toBe(true);
    const running = reduceTuiState(initial, {
      type: "message_submitted",
      message: "g1",
    });
    expect(canAcceptMessage(running)).toBe(false);
  });

  it("should reset feed and runStartedAt on message_submitted but keep cumulative metrics", () => {
    const initial = createInitialTuiState(fakeSession());
    const ts = Date.now();
    const after = apply(initial, [
      { type: "metric", sample: { name: "llm.prompt_tokens", value: 500, timestamp: ts } },
      { type: "agent_event", event: { type: "step_started", stepIndex: 0 } },
      { type: "agent_event", event: { type: "loop_completed", reason: "finish" } },
      { type: "message_submitted", message: "another message" },
    ]);
    expect(after.status).toBe("running");
    expect(after.feed).toHaveLength(0);
    expect(after.runStartedAt).not.toBeNull();
    expect(after.currentStep).toBe(0);
    expect(after.inputValue).toBe("");
    expect(after.metrics.totalTokens).toBe(500);
    expect(after.runHistory).toHaveLength(1);
  });

  it("should allow a full two-turn cycle: message → run → idle → message → run", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "agent_event", event: { type: "user_message", text: "first" } },
      { type: "message_submitted", message: "first" },
      { type: "agent_event", event: { type: "step_started", stepIndex: 0 } },
      { type: "agent_event", event: { type: "loop_completed", reason: "finish" } },
      { type: "agent_event", event: { type: "user_message", text: "second" } },
      { type: "message_submitted", message: "second" },
      { type: "agent_event", event: { type: "step_started", stepIndex: 0 } },
      { type: "agent_event", event: { type: "loop_completed", reason: "max_steps" } },
    ]);
    expect(next.status).toBe("idle");
    expect(next.runHistory.map((h) => h.message)).toEqual(["first", "second"]);
    expect(next.runHistory.map((h) => h.outcome)).toEqual(["completed", "completed"]);
  });

  it("should transition to quitting on quit_requested", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = reduceTuiState(initial, { type: "quit_requested" });
    expect(next.status).toBe("quitting");
    expect(next.aborting).toBe(true);
  });

  it("should accumulate reasoning entries from llm_event", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "message_submitted", message: "think hard" },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "reasoning", stepIndex: 0, text: "first thought" },
        },
      },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "reasoning", stepIndex: 1, text: "second thought" },
        },
      },
    ]);
    expect(next.reasoning).toHaveLength(2);
    expect(next.reasoning[0]?.text).toBe("first thought");
    expect(next.reasoning[0]?.stepIndex).toBe(0);
    expect(next.reasoning[1]?.stepIndex).toBe(1);
  });

  it("should clear reasoning on new message_submitted but keep prior run history", () => {
    const initial = createInitialTuiState(fakeSession());
    const afterFirstRun = apply(initial, [
      { type: "message_submitted", message: "g1" },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "reasoning", stepIndex: 0, text: "r1" },
        },
      },
      { type: "agent_event", event: { type: "loop_completed", reason: "finish" } },
    ]);
    expect(afterFirstRun.reasoning).toHaveLength(1);

    const afterSecondSubmit = reduceTuiState(afterFirstRun, {
      type: "message_submitted",
      message: "g2",
    });
    expect(afterSecondSubmit.reasoning).toHaveLength(0);
    expect(afterSecondSubmit.runHistory).toHaveLength(1);
  });

  it("should cap reasoning ring buffer", () => {
    const initial = createInitialTuiState(fakeSession(), 2);
    const actions: TuiAction[] = Array.from({ length: 5 }).map((_, i) => ({
      type: "agent_event",
      event: {
        type: "llm_event",
        event: { type: "reasoning", stepIndex: i, text: `r${i}` },
      },
    }));
    const next = apply(initial, actions);
    expect(next.reasoning).toHaveLength(2);
    expect(next.reasoning[0]?.text).toBe("r3");
    expect(next.reasoning[1]?.text).toBe("r4");
  });

  it("appends user message to chat transcript on user_message event", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = reduceTuiState(initial, {
      type: "agent_event",
      event: { type: "user_message", text: "hi there" },
    });
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toMatchObject({ role: "user", text: "hi there" });
  });

  it("appends assistant reply with tool-step count from current turn", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "agent_event", event: { type: "user_message", text: "hello" } },
      { type: "agent_event", event: { type: "turn_started", turnIndex: 0 } },
      { type: "agent_event", event: { type: "step_started", stepIndex: 0 } },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: {
            type: "tool_call_executed",
            result: {
              tool: "browser.navigate",
              status: "ok",
              summary: "done",
              truncated: false,
            },
          },
        },
      },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "assistant_reply", text: "all set" },
        },
      },
      {
        type: "agent_event",
        event: {
          type: "turn_finished",
          turnIndex: 0,
          reason: "reply",
          stepCount: 2,
          durationMs: 200,
        },
      },
    ]);
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1]).toMatchObject({
      role: "assistant",
      text: "all set",
      toolSteps: 1,
    });
    expect(next.status).toBe("idle");
    expect(next.lastRunStatus).toBe("turn reply");
    expect(next.runHistory.at(-1)?.outcome).toBe("completed");
  });

  it("reply tool call does not bump currentTurnToolSteps", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "agent_event", event: { type: "turn_started", turnIndex: 0 } },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: {
            type: "tool_call_executed",
            result: { tool: "reply", status: "ok", summary: "hi", truncated: false },
          },
        },
      },
    ]);
    expect(next.currentTurnToolSteps).toBe(0);
  });

  it("should compute non-zero durationMs for archived run", async () => {
    const initial = createInitialTuiState(fakeSession());
    const afterSubmit = reduceTuiState(initial, {
      type: "message_submitted",
      message: "x",
    });
    await new Promise((r) => setTimeout(r, 5));
    const next = reduceTuiState(afterSubmit, {
      type: "agent_event",
      event: { type: "loop_completed", reason: "finish" },
    });
    expect(next.runHistory[0]?.durationMs).toBeGreaterThan(0);
  });
});
