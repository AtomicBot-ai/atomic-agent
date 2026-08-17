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
    approvalLevel: 5,
    maxSteps: 10,
    skillCount: 0,
    localBackendConfigured: false,
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
      { type: "message_submitted" },
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
      { type: "message_submitted" },
      { type: "agent_event", event: { type: "loop_completed", reason: "cancelled" } },
    ]);
    expect(next.status).toBe("idle");
    expect(next.runHistory[0]?.outcome).toBe("cancelled");
  });

  it("should return to idle and archive run as failed on loop_failed", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "message_submitted" },
      { type: "agent_event", event: { type: "loop_failed", error: new Error("boom"), category: "tool" } },
    ]);
    expect(next.status).toBe("idle");
    expect(next.lastRunStatus).toBe("failed [tool]: boom");
    expect(next.runHistory[0]?.outcome).toBe("failed");
    expect(next.runHistory[0]?.reason).toBe("boom");
    const errMsg = next.messages.find(
      (m) => m.role === "system" && m.variant === "warn",
    );
    expect(errMsg?.text).toBe("Turn failed [tool]: boom");
  });

  it("maps loop_completed reason failed to failed outcome", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "message_submitted" },
      {
        type: "agent_event",
        event: { type: "loop_completed", reason: "failed" },
      },
    ]);
    expect(next.runHistory[0]?.outcome).toBe("failed");
    expect(next.lastRunStatus).toBe("failed: failed");
  });

  it("should render step_error with the failure category tag", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "message_submitted" },
      { type: "agent_event", event: { type: "step_started", stepIndex: 0 } },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: {
            type: "step_error",
            error: new Error("truncated"),
            category: "model",
          },
        },
      },
    ]);
    const errorEntry = next.feed.find((f) => f.kind === "step_error");
    expect(errorEntry).toBeDefined();
    expect(errorEntry?.line).toContain("[model]");
    expect(errorEntry?.line).toContain("truncated");
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

  it("should append reasoning_delta chunks into the matching step entry", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "reasoning_delta", stepIndex: 0, text: "hello " },
        },
      },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "reasoning_delta", stepIndex: 0, text: "world" },
        },
      },
    ]);
    expect(next.reasoning).toHaveLength(1);
    expect(next.reasoning[0]?.stepIndex).toBe(0);
    expect(next.reasoning[0]?.text).toBe("hello world");
  });

  it("should replace reasoning text with the canonical final reasoning event", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "reasoning_delta", stepIndex: 0, text: "partial" },
        },
      },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "reasoning", stepIndex: 0, text: "final canonical" },
        },
      },
    ]);
    expect(next.reasoning).toHaveLength(1);
    expect(next.reasoning[0]?.text).toBe("final canonical");
  });

  it("should accumulate assistant_delta chunks into streamingAssistantText", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "assistant_delta", text: "Hel" },
        },
      },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "assistant_delta", text: "lo!" },
        },
      },
    ]);
    expect(next.streamingAssistantText).toBe("Hello!");
  });

  it("should fold streamed reasoning into the final assistant ChatMessage", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "message_submitted" },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "reasoning_delta", stepIndex: 0, text: "plan " },
        },
      },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "reasoning", stepIndex: 0, text: "plan v2" },
        },
      },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "assistant_reply", text: "the answer" },
        },
      },
    ]);
    const lastMessage = next.messages.at(-1);
    expect(lastMessage?.role).toBe("assistant");
    expect(lastMessage?.text).toBe("the answer");
    expect(lastMessage?.reasoningBlocks).toContain("plan v2");
  });

  it("should clear live reasoning on assistant_reply so the tail does not re-expand it", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "message_submitted" },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "reasoning", stepIndex: 0, text: "some chain of thought" },
        },
      },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "assistant_delta", text: "Par" },
        },
      },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "assistant_reply", text: "Partial answer" },
        },
      },
    ]);
    // Live reasoning/streaming state must be wiped so StreamingTail renders
    // nothing; the finalised message carries reasoningBlocks instead.
    expect(next.reasoning).toEqual([]);
    expect(next.streamingAssistantText).toBeNull();
    expect(next.streamingToolCalls).toEqual([]);
    expect(next.streamingToolCards).toEqual([]);
    expect(next.messages.at(-1)?.reasoningBlocks).toContain("some chain of thought");
  });

  it("mirrors approval_level_changed into state.session for the diagnostics line", () => {
    const initial = createInitialTuiState(fakeSession({ approvalLevel: 1 }));
    const up = reduceTuiState(initial, {
      type: "approval_level_changed",
      approvalLevel: 5,
    });
    expect(up.session.approvalLevel).toBe(5);
    const down = reduceTuiState(up, {
      type: "approval_level_changed",
      approvalLevel: 2,
    });
    expect(down.session.approvalLevel).toBe(2);
  });
});

describe("llm health visibility", () => {
  it("does not mark local as configured just because a probe failed", () => {
    const state = apply(createInitialTuiState(fakeSession()), [
      {
        type: "llm_health_updated",
        status: "unreachable",
        checkedAt: 1,
        latencyMs: null,
        error: "connect ECONNREFUSED 127.0.0.1:8080",
      },
    ]);

    // A fresh install probes a default URL nobody chose; a refusal there is
    // not news, and the badge stays hidden.
    expect(state.llmHealth.status).toBe("unreachable");
    expect(state.llmHealth.localConfigured).toBe(false);
  });

  it("latches on after a healthy probe and survives the server dying", () => {
    const healthy = apply(createInitialTuiState(fakeSession()), [
      {
        type: "llm_health_updated",
        status: "healthy",
        checkedAt: 1,
        latencyMs: 3,
        error: null,
      },
    ]);
    expect(healthy.llmHealth.localConfigured).toBe(true);

    // Somebody who really runs llama-server keeps the signal when it stops.
    const died = apply(healthy, [
      {
        type: "llm_health_updated",
        status: "unreachable",
        checkedAt: 2,
        latencyMs: null,
        error: "connect ECONNREFUSED 127.0.0.1:8080",
      },
    ]);
    expect(died.llmHealth.localConfigured).toBe(true);
    expect(died.llmHealth.status).toBe("unreachable");
  });

  it("starts visible when config already says local", () => {
    const state = createInitialTuiState(
      fakeSession({ localBackendConfigured: true }),
    );
    expect(state.llmHealth.localConfigured).toBe(true);
  });
});

