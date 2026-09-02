import { describe, expect, it } from "vitest";
import type { BuiltPrompt } from "../prompt/build-prompt-types.js";
import { reduceTuiState, type TuiAction } from "./agent-event-reducer.js";
import { providerRow } from "./composer-switch/composer-switch-fixtures.js";
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
    completionMaxTokens: 2048,
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
    const next = apply(initial, [
      // The request freezes the composer only when it was raised by the
      // session on screen.
      { type: "session_created", sessionId: "s-1" },
      { type: "approval_requested", request },
    ]);
    expect(next.status).toBe("awaiting_approval");
    expect(next.pendingApproval?.approvalId).toBe("a-1");
  });

  it("points at a background session's approval instead of arming the modal", () => {
    // A turn the operator switched away from (or a scheduled task's
    // turn) can still raise an approval, but it must NOT occupy
    // `pendingApproval`: every approval key answers whatever that slot
    // holds, so a reflexive Ctrl+C would deny a call the operator
    // cannot see. The transcript gets a pointer naming the owner; the
    // orchestrator re-raises the prompt when that session is switched
    // into.
    const initial = createInitialTuiState(fakeSession());
    const request = {
      approvalId: "a-bg",
      sessionId: "s-background",
      tool: "os.shell.exec",
      category: "shell" as const,
      reason: "dangerous shell command",
    };
    const next = apply(initial, [
      { type: "session_created", sessionId: "s-visible" },
      { type: "approval_requested", request },
    ]);
    expect(next.pendingApproval).toBeNull();
    expect(next.status).toBe("idle");
    const notice = next.messages.at(-1);
    expect(notice?.role).toBe("system");
    expect(notice?.text).toContain("s-background");
    expect(notice?.text).toContain("switch to it to answer");
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
      { type: "session_created", sessionId: "s-1" },
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

  describe("context usage", () => {
    const prompt = (
      overrides: Partial<BuiltPrompt> = {},
    ): BuiltPrompt =>
      ({
        text: "",
        stablePrefix: "",
        tail: "",
        tokens: {
          stablePrefix: 5000,
          loadedSkills: 0,
          sessionFacts: 0,
          loadedTools: 0,
          profile: 0,
          worldSnapshot: 0,
          conversation: 7000,
          recalled: 0,
          memoryIndex: 0,
          taskPolicy: 0,
          total: 12_000,
        },
        limits: {
          total: 40_000,
          stablePrefix: 14_000,
          session: 6000,
          worldSnapshot: 6000,
          conversation: 14_000,
        },
        truncated: false,
        truncation: {
          loadedSkills: false,
          sessionFacts: false,
          loadedTools: false,
          profile: false,
          worldSnapshot: false,
          conversation: false,
          recalled: false,
          memoryIndex: false,
        },
        contextWindow: 32_768,
        conversationCapEffective: 14_000,
        droppedTurns: 0,
        ...overrides,
      }) as BuiltPrompt;

    const promptBuilt = (overrides: Partial<BuiltPrompt> = {}): TuiAction => ({
      type: "agent_event",
      event: {
        type: "llm_event",
        event: { type: "prompt_built", prompt: prompt(overrides), slotId: 0 },
      },
    });

    it("reads the window fill off the built prompt", () => {
      const next = apply(createInitialTuiState(fakeSession()), [
        promptBuilt({ droppedTurns: 3 }),
      ]);
      expect(next.contextUsage.tokens).toBe(12_000);
      expect(next.contextUsage.contextWindow).toBe(32_768);
      expect(next.contextUsage.droppedTurns).toBe(3);
      expect(next.contextUsage.sections.map((s) => s.label)).toEqual([
        "prompt scaffold",
        "conversation",
      ]);
    });

    /**
     * `prompt_built` carries `estimateTokens`, which over-counts by
     * design. The completion carries what the provider's own tokenizer
     * saw, and that is the figure worth showing.
     */
    it("replaces the estimate with the provider's own count", () => {
      const next = apply(createInitialTuiState(fakeSession()), [
        promptBuilt(),
        {
          type: "agent_event",
          event: {
            type: "llm_event",
            event: {
              type: "llm_completed",
              completion: {
                timing: { promptTokens: 10_450 },
              } as never,
            },
          },
        },
      ]);
      expect(next.contextUsage.tokens).toBe(10_450);
      // Everything else came from the prompt and still stands.
      expect(next.contextUsage.contextWindow).toBe(32_768);
    });

    it("keeps the estimate when the provider reports no count", () => {
      const next = apply(createInitialTuiState(fakeSession()), [
        promptBuilt(),
        {
          type: "agent_event",
          event: {
            type: "llm_event",
            event: { type: "llm_completed", completion: {} as never },
          },
        },
      ]);
      expect(next.contextUsage.tokens).toBe(12_000);
    });

    /**
     * The regression this slice exists to avoid: `startNewRun` wipes
     * every per-turn metric, and the window is emphatically not a
     * per-turn metric — it does not empty when you press Enter.
     */
    it("survives the start of the next turn", () => {
      const started = apply(createInitialTuiState(fakeSession()), [
        promptBuilt(),
        {
          type: "agent_event",
          event: {
            type: "llm_event",
            event: {
              type: "prompt_captured",
              stepIndex: 0,
              stablePrefixHash: "h",
              tail: "",
              tokens: { total: 12_000, stablePrefix: 5000, tail: 7000 },
              slotId: 0,
              cacheReused: true,
            },
          },
        },
      ]);
      // Both readouts are populated before the turn boundary…
      expect(started.metrics.promptTokensLast).toBe(12_000);
      expect(started.contextUsage.tokens).toBe(12_000);

      const next = reduceTuiState(started, { type: "message_submitted" });
      // …and only the per-turn metric is cleared by it.
      expect(next.metrics.promptTokensLast).toBeNull();
      expect(next.contextUsage.tokens).toBe(12_000);
    });

    it("resets when the transcript is cleared or the session changes", () => {
      const built = apply(createInitialTuiState(fakeSession()), [promptBuilt()]);
      expect(reduceTuiState(built, { type: "chat_cleared" }).contextUsage.tokens).toBeNull();
      expect(
        reduceTuiState(built, { type: "session_created", sessionId: "s2" })
          .contextUsage.tokens,
      ).toBeNull();
    });
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

  it("appends the llama hint on transport failure for a custom-id llama-server route", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      {
        type: "providers_refresh",
        rows: [
          // KIND is what makes the route local — the id is deliberately
          // not `local-llama`.
          providerRow({
            id: "my-llama",
            kind: "llama-server",
            isActiveText: true,
            hasApiKey: false,
            chatModel: null,
            chatModelOptions: [],
          }),
        ],
      },
      { type: "message_submitted" },
      {
        type: "agent_event",
        event: {
          type: "loop_failed",
          error: new Error("fetch failed"),
          category: "transport",
        },
      },
    ]);
    const errMsg = next.messages.find(
      (m) => m.role === "system" && m.variant === "warn",
    );
    expect(errMsg?.text).toContain(
      "llama-server is not reachable at http://127.0.0.1:8080",
    );
  });

  it("keeps the llama hint off a cloud route's transport failure", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      {
        type: "providers_refresh",
        rows: [providerRow({ id: "openrouter", kind: "openrouter", isActiveText: true })],
      },
      { type: "message_submitted" },
      {
        type: "agent_event",
        event: {
          type: "loop_failed",
          error: new Error("fetch failed"),
          category: "transport",
        },
      },
    ]);
    const errMsg = next.messages.find(
      (m) => m.role === "system" && m.variant === "warn",
    );
    expect(errMsg?.text).toBe("Turn failed [transport]: fetch failed");
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

  it("renders a mid-turn steer inline in the turn that is already running", () => {
    const running = apply(createInitialTuiState(fakeSession()), [
      { type: "agent_event", event: { type: "user_message", text: "deploy" } },
      { type: "message_submitted" },
      { type: "agent_event", event: { type: "turn_started", turnIndex: 0 } },
      { type: "agent_event", event: { type: "step_started", stepIndex: 0 } },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: {
            type: "tool_call_executed",
            result: {
              tool: "os.fs.read",
              status: "ok",
              summary: "read config",
              truncated: false,
            },
          },
        },
      },
      { type: "agent_event", event: { type: "step_started", stepIndex: 1 } },
    ]);
    const feedBefore = running.feed.length;

    const next = reduceTuiState(running, {
      type: "agent_event",
      event: { type: "steer_applied", text: "use the staging db", stepIndex: 1 },
    });

    // The operator's words show up as a user message, in the same
    // transcript as everything else...
    const last = next.messages[next.messages.length - 1];
    expect(last?.role).toBe("user");
    expect(last?.text).toBe("use the staging db");
    // ...with a feed line tying it to the step it reached.
    expect(next.feed.length).toBe(feedBefore + 1);
    expect(next.feed[next.feed.length - 1]?.line).toContain("step 1");
    // ...and none of the per-turn resets a NEW turn would bring: this
    // is a correction to the turn in flight, not the start of one.
    expect(next.status).toBe("running");
    expect(next.currentStep).toBe(1);
    expect(next.currentTurnToolSteps).toBe(running.currentTurnToolSteps);
    expect(next.runStartedAt).toBe(running.runStartedAt);
  });

  it("reports a trimmed tool batch instead of swallowing it", () => {
    const next = apply(createInitialTuiState(fakeSession()), [
      { type: "agent_event", event: { type: "step_started", stepIndex: 0 } },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: {
            type: "batch_trimmed",
            stepIndex: 0,
            originalSize: 3,
            kept: "os.fs.write",
            dropped: ["os.shell.run", "os.fs.trash"],
            reason: "approval-gated-batched",
          },
        },
      },
    ]);
    const line = next.feed[next.feed.length - 1]?.line ?? "";
    expect(line).toContain("os.fs.write");
    expect(line).toContain("2 of 3");
  });

  it("reports a wave-split batch without implying anything was dropped", () => {
    const next = apply(createInitialTuiState(fakeSession()), [
      { type: "agent_event", event: { type: "step_started", stepIndex: 0 } },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: {
            type: "batch_wave_split",
            stepIndex: 0,
            originalSize: 14,
            cap: 8,
            waveCount: 2,
            boundaries: [0, 8],
          },
        },
      },
    ]);
    const line = next.feed[next.feed.length - 1]?.line ?? "";
    expect(line).toContain("14 reads");
    expect(line).toContain("2 waves");
    expect(line).toContain("nothing dropped");
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


describe("turn_gate_blocked", () => {
  it("after a fresh submit: prints the warn message and hands the composer back", () => {
    const submitted = apply(createInitialTuiState(fakeSession()), [
      { type: "message_submitted" },
    ]);
    expect(submitted.status).toBe("running");

    const blocked = reduceTuiState(submitted, {
      type: "turn_gate_blocked",
      text: "local model qwen-3.5-4b is not downloaded — open Models (/local) and press Enter on it to download",
    });

    expect(blocked.status).toBe("idle");
    expect(canAcceptMessage(blocked)).toBe(true);
    const last = blocked.messages.at(-1);
    expect(last?.role).toBe("system");
    expect(last?.variant).toBe("warn");
    expect(last?.text).toContain("qwen-3.5-4b");
    expect(blocked.feed.at(-1)?.line).toContain("blocked:");
  });

  it("a blocked fresh submit makes no run-history entry — it never ran", () => {
    const next = apply(createInitialTuiState(fakeSession()), [
      // A full earlier turn, so the trap has bait: the blocked text
      // never reaches `state.messages`, and a history entry minted for
      // the block would carry THIS message instead.
      { type: "agent_event", event: { type: "user_message", text: "earlier turn" } },
      { type: "message_submitted" },
      { type: "agent_event", event: { type: "loop_completed", reason: "finish" } },
      { type: "message_submitted" },
      {
        type: "turn_gate_blocked",
        text: "local model qwen-3.5-4b is not downloaded (message returned to the editor)",
      },
    ]);
    expect(next.status).toBe("idle");
    expect(next.lastRunStatus).toBe("blocked: local model not ready");
    expect(next.runHistory).toHaveLength(1);
    expect(next.runHistory[0]?.outcome).toBe("completed");
    expect(next.runHistory[0]?.message).toBe("earlier turn");
  });

  it("at drain time (already idle): message only, no phantom run-history entry", () => {
    const initial = createInitialTuiState(fakeSession());
    const blocked = reduceTuiState(initial, {
      type: "turn_gate_blocked",
      text: "local model qwen-3.5-4b is not downloaded\n  dropped: second",
    });

    expect(blocked.status).toBe("idle");
    expect(blocked.runHistory).toHaveLength(0);
    expect(blocked.messages.at(-1)?.text).toContain("dropped: second");
    // The feed line stays single-line even for a multi-line message.
    expect(blocked.feed.at(-1)?.line).not.toContain("\n");
  });
});

describe("update banner state", () => {
  const offer: TuiAction = {
    type: "update_available",
    current: "0.5.4",
    latest: "9.9.9",
  };

  it("update_available raises both the modal and the banner", () => {
    const next = reduceTuiState(createInitialTuiState(fakeSession()), offer);
    expect(next.updatePrompt).toEqual({ current: "0.5.4", latest: "9.9.9" });
    expect(next.updateBanner).toEqual({ current: "0.5.4", latest: "9.9.9" });
  });

  it("update_dismissed clears only the modal — the banner is the memory", () => {
    const next = apply(createInitialTuiState(fakeSession()), [
      offer,
      { type: "update_dismissed" },
    ]);
    expect(next.updatePrompt).toBeNull();
    expect(next.updateBanner).toEqual({ current: "0.5.4", latest: "9.9.9" });
  });

  it("a repeat offer while an update runs still changes nothing", () => {
    const running = apply(createInitialTuiState(fakeSession()), [
      offer,
      { type: "update_started" },
    ]);
    expect(reduceTuiState(running, offer)).toBe(running);
  });
});
