import { withReportHint } from "./format-agent-error-for-chat.js";
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

describe("reduceTuiState fusion worker progress", () => {
  const feedLines = (events: Parameters<typeof reduceTuiState>[1][]): string[] =>
    apply(createInitialTuiState(fakeSession()), events).feed.map((f) => f.line);

  it("shows one line when a worker starts and one when it finishes", () => {
    // A fan-out can hold the orchestrator's turn for minutes with no
    // steps of its own to show; without these lines the TUI goes quiet.
    const lines = feedLines([
      {
        type: "agent_event",
        event: {
          type: "fusion_worker",
          taskId: "t1",
          title: "Map the routes",
          phase: "started",
        },
      },
      {
        type: "agent_event",
        event: {
          type: "fusion_worker",
          taskId: "t1",
          title: "Map the routes",
          phase: "finished",
          stepCount: 5,
          durationMs: 9000,
          summary: "12 routes, 3 unauthenticated",
        },
      },
    ]);
    expect(lines).toEqual([
      "» worker Map the routes: started",
      "» worker Map the routes: done — 5 steps, 12 routes, 3 unauthenticated",
    ]);
  });

  it("renders the failed and cancelled phases distinctly", () => {
    const lines = feedLines([
      {
        type: "agent_event",
        event: {
          type: "fusion_worker",
          taskId: "t1",
          title: "A",
          phase: "failed",
          summary: "provider exploded",
        },
      },
      {
        type: "agent_event",
        event: { type: "fusion_worker", taskId: "t2", title: "B", phase: "cancelled" },
      },
    ]);
    expect(lines).toEqual([
      "» worker A: failed — provider exploded",
      "» worker B: cancelled",
    ]);
  });

  it("attributes every line to the model that ran it", () => {
    // Fusion is the one mode where two models on two bills share a
    // single turn, and a worker's own step events are dropped by the
    // reducer's session filter — so these lines are the only place the
    // division of work is visible at all.
    const lines = feedLines([
      {
        type: "agent_event",
        event: {
          type: "fusion_worker",
          taskId: "fusion.delegate",
          title: "2 tasks",
          phase: "tool",
          role: "orchestrator",
          model: "claude-sonnet-4.5",
          tool: "fusion.delegate",
        },
      },
      {
        type: "agent_event",
        event: {
          type: "fusion_worker",
          taskId: "t2",
          title: "2",
          phase: "tool",
          role: "worker",
          model: "qwen-3.5-4b",
          tool: "os.fs.write",
        },
      },
      {
        type: "agent_event",
        event: {
          type: "fusion_worker",
          taskId: "t2",
          title: "2",
          phase: "finished",
          role: "worker",
          model: "qwen-3.5-4b",
          stepCount: 4,
        },
      },
    ]);
    expect(lines).toEqual([
      "» orchestrator · claude-sonnet-4.5 — fusion.delegate (2 tasks)",
      "» worker 2 · qwen-3.5-4b — os.fs.write",
      "» worker 2 · qwen-3.5-4b: done — 4 steps",
    ]);
  });

  it("does not disturb the turn's own status or step counter", () => {
    // These events belong to the parent turn as a whole, not to any one
    // of its steps — they must not read as a step boundary.
    const running = apply(createInitialTuiState(fakeSession()), [
      { type: "agent_event", event: { type: "step_started", stepIndex: 3 } },
    ]);
    const after = reduceTuiState(running, {
      type: "agent_event",
      event: { type: "fusion_worker", taskId: "t1", title: "A", phase: "started" },
    });
    expect(after.status).toBe(running.status);
    expect(after.currentStep).toBe(3);
    expect(after.feed.at(-1)?.stepIndex).toBeNull();
  });
});

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
    expect(errMsg?.text).toBe(withReportHint("Turn failed [tool]: boom"));
  });

  it("renders a calm stopped-by-user notice with a retry prompt on a cancelled loop_failed", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "agent_event", event: { type: "user_message", text: "count the stars" } },
      { type: "message_submitted" },
      {
        type: "agent_event",
        event: {
          type: "loop_failed",
          error: new Error("This operation was aborted"),
          category: "cancelled",
        },
      },
    ]);
    expect(next.status).toBe("idle");
    expect(next.lastRunStatus).toBe("stopped by user");
    expect(next.runHistory[0]?.outcome).toBe("cancelled");
    // No warn-styled "Turn failed" wall: the operator did this on
    // purpose and the notice says so, carrying the aborted turn's
    // prompt for the [try again] affordance.
    const warn = next.messages.find(
      (m) => m.role === "system" && m.variant === "warn",
    );
    expect(warn).toBeUndefined();
    const notice = next.messages.find((m) => m.role === "system");
    expect(notice?.text).toBe("Agent stopped by user.");
    expect(notice?.retryText).toBe("count the stars");
  });

  it("treats any loop_failed during a requested abort as stopped-by-user", () => {
    // The abort races the LLM stream: a killed response can surface as
    // `[model] model returned empty content` before the AbortError
    // does. With `abort_requested` on the books, that is still the
    // operator's stop, not a provider failure.
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "agent_event", event: { type: "user_message", text: "count the stars" } },
      { type: "message_submitted" },
      { type: "abort_requested" },
      {
        type: "agent_event",
        event: {
          type: "loop_failed",
          error: new Error("model returned empty content"),
          category: "model",
        },
      },
    ]);
    expect(next.lastRunStatus).toBe("stopped by user");
    expect(next.aborting).toBe(false);
    const notice = next.messages.find((m) => m.role === "system");
    expect(notice?.text).toBe("Agent stopped by user.");
    expect(notice?.retryText).toBe("count the stars");
  });

  it("keeps the warn styling for a loop_failed with no abort on the books", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "message_submitted" },
      {
        type: "agent_event",
        event: {
          type: "loop_failed",
          error: new Error("model returned empty content"),
          category: "model",
        },
      },
    ]);
    const warn = next.messages.find(
      (m) => m.role === "system" && m.variant === "warn",
    );
    expect(warn?.text).toBe(withReportHint("Turn failed [model]: model returned empty content"));
  });

  it("leaves retryText off the stopped notice when no user message exists to re-run", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "message_submitted" },
      {
        type: "agent_event",
        event: {
          type: "loop_failed",
          error: new Error("This operation was aborted"),
          category: "cancelled",
        },
      },
    ]);
    const notice = next.messages.find((m) => m.role === "system");
    expect(notice?.text).toBe("Agent stopped by user.");
    expect(notice?.retryText).toBeUndefined();
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
    // Exactly the base line and nothing else. `fetch failed` is undici's
    // catch-all for a connection that never opened as much as for one
    // that died (verified on Node 22.22.2: `ENOTFOUND` and `ECONNREFUSED`
    // both surface as this bare string), so neither hint may fire — the
    // llama one names the wrong server on a cloud route, and the drop one
    // would assert a reply was cut off on a turn that may have completed
    // zero steps.
    expect(errMsg?.text).toBe(withReportHint("Turn failed [transport]: fetch failed"));
  });

  it("explains a cloud route's mid-stream drop through the whole reducer", () => {
    // The reported shape: a cloud provider's stream dies mid-body and
    // undici's message is the single word `terminated`.
    // Source: Discord #feedback-and-bugs, 2026-09-03.
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
          error: new Error("terminated"),
          category: "transport",
        },
      },
    ]);
    const errMsg = next.messages.find(
      (m) => m.role === "system" && m.variant === "warn",
    );
    expect(errMsg?.text).toContain("Turn failed [transport]: terminated");
    expect(errMsg?.text).toContain(
      "the connection to the model dropped before the reply finished",
    );
    expect(errMsg?.text).toContain(
      "the steps that already finished are kept in this session",
    );
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

  it("carries reply attachments onto the finalised assistant message", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "message_submitted" },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: {
            type: "assistant_reply",
            text: "here is the report",
            attachments: ["/tmp/report.pdf"],
          },
        },
      },
    ]);
    expect(next.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "here is the report",
      attachments: ["/tmp/report.pdf"],
    });
    // A reply without attachments does not grow a stray field.
    const plain = apply(initial, [
      { type: "message_submitted" },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "assistant_reply", text: "plain" },
        },
      },
    ]);
    expect(plain.messages.at(-1)).not.toHaveProperty("attachments");
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

describe("truncated completion", () => {
  it("says what was cut and what the retry changes", () => {
    const next = reduceTuiState(createInitialTuiState(fakeSession()), {
      type: "agent_event",
      event: {
        type: "completion_truncated",
        stepIndex: 3,
        cause: "reply_cap",
        completionTokens: 8_192,
        promptTokens: 6_000,
        requestedMaxTokens: 8_192,
        retry: { kind: "raise_cap", maxTokens: 32_768 },
      } as never,
    });
    const line = next.feed.at(-1)?.line ?? "";
    expect(line).toContain("reply cut off at 8192 tokens");
    expect(line).toContain("step 4");
    expect(line).toContain("32768-token cap");
    expect(next.feed.at(-1)?.color).toBe("yellow");
  });

  it("explains a window retry in the operator's terms", () => {
    const next = reduceTuiState(createInitialTuiState(fakeSession()), {
      type: "agent_event",
      event: {
        type: "completion_truncated",
        stepIndex: 0,
        cause: "context_window",
        completionTokens: 2_768,
        promptTokens: 30_000,
        requestedMaxTokens: 8_192,
        retry: { kind: "fit_window", contextWindow: 32_768 },
      } as never,
    });
    const line = next.feed.at(-1)?.line ?? "";
    expect(line).toContain("ran out of context at ~32768 tokens");
    expect(line).toContain("trimming the conversation");
  });
});

describe("provider outage", () => {
  const waiting = (over: Record<string, unknown> = {}): TuiAction => ({
    type: "agent_event",
    event: {
      type: "provider_waiting",
      attempt: 1,
      waitedMs: 0,
      maxWaitMs: 300_000,
      nextRetryMs: 2_000,
      reason: "fetch failed",
      ...over,
    } as never,
  });

  const step = (stepIndex: number): TuiAction => ({
    type: "agent_event",
    event: { type: "step_started", stepIndex },
  });

  const reasoningDelta = (stepIndex: number, text: string): TuiAction => ({
    type: "agent_event",
    event: {
      type: "llm_event",
      event: { type: "reasoning_delta", stepIndex, text },
    } as never,
  });

  it("shows the outage and says how long it will keep trying", () => {
    const next = reduceTuiState(createInitialTuiState(fakeSession()), waiting());
    expect(next.providerOutage).toMatchObject({
      reason: "fetch failed",
      attempt: 1,
      phase: "parked",
      givenUp: false,
    });
    expect(next.providerOutage?.sinceTs).toBeGreaterThan(0);
    expect(next.feed.at(-1)?.line).toContain("provider not answering");
    expect(next.feed.at(-1)?.line).toContain("retrying in 2s");
  });

  it("flips to `retrying` when the parked step goes back on the wire", () => {
    // The loop emits nothing between the backoff and
    // `provider_recovered`, which only lands once the replayed step has
    // *finished*. `step_started` during an outage is the one event that
    // says the retry is live, and without it a step that streams for
    // minutes leaves the row counting a wait that is already over.
    const parked = apply(createInitialTuiState(fakeSession()), [
      step(4),
      waiting(),
    ]);
    expect(parked.providerOutage).toMatchObject({ phase: "parked" });
    const retrying = reduceTuiState(parked, step(4));
    expect(retrying.providerOutage).toMatchObject({
      phase: "retrying",
      attempt: 1,
      // The wait total is not rewritten — the next `provider_waiting`
      // owns it, and the readout counts the retry off `sinceTs`.
      waitedMs: 0,
    });
    expect(retrying.providerOutage?.sinceTs).toBeGreaterThanOrEqual(
      parked.providerOutage?.sinceTs ?? 0,
    );
  });

  it("drops the dead attempt's reasoning instead of splicing the retry onto it", () => {
    // `appendReasoningDelta` merges into the trailing entry whenever the
    // step index matches, so the retry's thinking used to be welded onto
    // the tail of the attempt whose socket died — the model's reasoning
    // shown twice, joined mid-sentence.
    const next = apply(createInitialTuiState(fakeSession()), [
      step(2),
      reasoningDelta(2, "first attempt thinking"),
      waiting({ reason: "terminated" }),
      step(2),
      reasoningDelta(2, "retry thinking"),
    ]);
    expect(next.reasoning).toHaveLength(1);
    expect(next.reasoning[0]?.text).toBe("retry thinking");
  });

  it("clears the dead attempt's streamed reply and half-parsed tool calls", () => {
    const parked: TuiState = {
      ...apply(createInitialTuiState(fakeSession()), [step(1), waiting()]),
      streamingAssistantText: "half a sentence before the socket",
      streamingToolCalls: [
        {
          id: "call_1",
          stepIndex: 1,
          tool: "os.fs.read",
          args: {},
          startedAt: Date.now(),
        },
      ],
    };
    const retrying = reduceTuiState(parked, step(1));
    expect(retrying.streamingAssistantText).toBeNull();
    expect(retrying.streamingToolCalls).toEqual([]);
  });

  it("leaves an ordinary step start completely alone", () => {
    // The retry branch hangs off `step_started`, which every turn fires
    // for every step. With no outage live it must change nothing.
    const before = apply(createInitialTuiState(fakeSession()), [
      step(0),
      reasoningDelta(0, "thinking"),
    ]);
    const after = reduceTuiState(
      { ...before, streamingAssistantText: "partial" },
      step(0),
    );
    expect(after.providerOutage).toBeNull();
    expect(after.reasoning).toHaveLength(1);
    expect(after.reasoning[0]?.text).toBe("thinking");
    expect(after.streamingAssistantText).toBe("partial");
  });

  it("does not turn a given-up outage back into a live wait", () => {
    // The badge is past tense and sticky until a turn actually
    // succeeds; the next turn's first step must not restart a countdown.
    const dead = apply(createInitialTuiState(fakeSession()), [
      waiting(),
      {
        type: "agent_event",
        event: {
          type: "loop_failed",
          error: new Error("fetch failed"),
          category: "transport",
        },
      },
    ]);
    const next = reduceTuiState(dead, step(0));
    expect(next.providerOutage).toMatchObject({
      givenUp: true,
      phase: "parked",
    });
  });

  const turnFinished = (reason: string): TuiAction => ({
    type: "agent_event",
    event: {
      type: "turn_finished",
      turnIndex: 0,
      reason,
      stepCount: 1,
      durationMs: 20,
    } as never,
  });

  it.each(["cancelled", "max_steps"])(
    "takes a live wait down with the turn that ended %s",
    (reason) => {
      // `waiting` and `retrying` are claims about a turn that is on the
      // wire. Esc during the backoff is the ending the loop's own feed
      // line advertises ("· Esc stops"), and it used to leave the
      // readout standing and counting — measured live at 19s and
      // climbing, fourteen seconds after the loop was dead.
      const ended = apply(createInitialTuiState(fakeSession()), [
        step(0),
        waiting(),
        turnFinished(reason),
      ]);
      expect(ended.providerOutage).toBeNull();
    },
  );

  it("does not read the next turn's first step as the parked one", () => {
    const ended = apply(createInitialTuiState(fakeSession()), [
      step(0),
      waiting(),
      turnFinished("cancelled"),
    ]);
    const fresh = apply(ended, [
      { type: "agent_event", event: { type: "turn_started" } as never },
      step(0),
    ]);
    expect(fresh.providerOutage).toBeNull();
  });

  it("keeps the given-up badge across an aborted turn", () => {
    // Sticky on purpose: the next message fails the same way until the
    // link is back, and a state that clears itself between attempts is
    // how eight identical failures read as eight separate surprises.
    const dead = apply(createInitialTuiState(fakeSession()), [
      waiting(),
      {
        type: "agent_event",
        event: {
          type: "loop_failed",
          error: new Error("fetch failed"),
          category: "transport",
        },
      },
      turnFinished("failed"),
    ]);
    expect(dead.providerOutage).toMatchObject({ givenUp: true });
    expect(reduceTuiState(dead, turnFinished("cancelled")).providerOutage)
      .toMatchObject({ givenUp: true });
  });

  it("clears the given-up badge once a turn reaches the model", () => {
    const dead = apply(createInitialTuiState(fakeSession()), [
      waiting(),
      {
        type: "agent_event",
        event: {
          type: "loop_failed",
          error: new Error("fetch failed"),
          category: "transport",
        },
      },
      turnFinished("failed"),
    ]);
    expect(reduceTuiState(dead, turnFinished("reply")).providerOutage).toBeNull();
  });

  it("does not repeat the feed line on every retry", () => {
    // The backoff fires every few seconds at first; the meta-row carries
    // the live numbers, so a wall of identical lines would only bury the
    // work above it.
    const next = apply(createInitialTuiState(fakeSession()), [
      waiting(),
      waiting({ attempt: 2, waitedMs: 2_000, nextRetryMs: 4_000 }),
      waiting({ attempt: 3, waitedMs: 6_000, nextRetryMs: 8_000 }),
    ]);
    expect(next.feed.filter((f) => f.line.includes("provider not answering"))).toHaveLength(1);
    expect(next.providerOutage).toMatchObject({ attempt: 3, waitedMs: 6_000 });
  });

  it("clears on recovery and says how long it waited", () => {
    const next = apply(createInitialTuiState(fakeSession()), [
      waiting(),
      {
        type: "agent_event",
        event: { type: "provider_recovered", waitedMs: 6_000 } as never,
      },
    ]);
    expect(next.providerOutage).toBeNull();
    expect(next.feed.at(-1)?.line).toContain("provider answered again after 6s");
  });

  it("stays on screen when the wait ran out and the turn failed", () => {
    // The sticky half: the next message will fail the same way, and a
    // state that cleared between attempts is how eight identical
    // failures read as eight separate surprises.
    const next = apply(createInitialTuiState(fakeSession()), [
      waiting(),
      {
        type: "agent_event",
        event: {
          type: "loop_failed",
          error: new Error("fetch failed"),
          category: "transport",
        },
      },
    ]);
    expect(next.providerOutage).toMatchObject({ givenUp: true });
  });

  it("clears when a turn actually completes", () => {
    const next = apply(createInitialTuiState(fakeSession()), [
      waiting(),
      {
        type: "agent_event",
        event: {
          type: "turn_finished",
          turnIndex: 0,
          reason: "reply",
          stepCount: 3,
          durationMs: 10,
        },
      },
    ]);
    expect(next.providerOutage).toBeNull();
  });

  it("leaves the context gauge alone", () => {
    // The readout at the bottom of the screen is driven by
    // `prompt_built` / `llm_completed` only. A parked turn builds no new
    // prompt and gets no completion, so the gauge must hold the last
    // measured value rather than resetting, moving or disappearing.
    const built = createInitialTuiState(fakeSession());
    const withUsage: TuiState = {
      ...built,
      contextUsage: { ...built.contextUsage, tokens: 12_345, window: 32_768 },
    };
    const next = apply(withUsage, [
      waiting(),
      waiting({ attempt: 2, waitedMs: 2_000 }),
      {
        type: "agent_event",
        event: { type: "provider_recovered", waitedMs: 6_000 } as never,
      },
    ]);
    expect(next.contextUsage.tokens).toBe(12_345);
    expect(next.contextUsage.window).toBe(32_768);
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

describe("a fallover away from the primary is said in the chat, not only the feed", () => {
  const away = {
    type: "provider_switched" as const,
    direction: "away" as const,
    from: "openrouter",
    to: "local-llama",
    reason: '"openrouter" rejected the request (402).',
  };

  it("posts one system message naming the cause and what answers now", () => {
    const next = apply(createInitialTuiState(fakeSession()), [
      { type: "agent_event", event: away },
    ]);
    const system = next.messages.filter((m) => m.role === "system");
    expect(system).toHaveLength(1);
    expect(system[0]?.text).toContain("openrouter");
    expect(system[0]?.text).toContain("local-llama");
    expect(system[0]?.variant).toBe("warn");
    // and it carries the offer to go and change the order
    expect(system[0]?.action).toBe("configure-fallback");
    // and the feed line the Fallback pane relies on is still there
    expect(next.feed.some((f) => f.line.includes("failed over"))).toBe(true);
  });

  it("does not repeat itself when the chain re-announces the same switch", () => {
    const s = apply(createInitialTuiState(fakeSession()), [
      { type: "agent_event", event: away },
      { type: "agent_event", event: away },
    ]);
    expect(s.messages.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("says nothing in the chat when the primary recovers", () => {
    const first = apply(createInitialTuiState(fakeSession()), [
      { type: "agent_event", event: away },
    ]);
    const before = first.messages.length;
    const s = apply(first, [
      {
        type: "agent_event",
        event: {
          type: "provider_switched",
          direction: "back",
          from: "local-llama",
          to: "openrouter",
          reason: "probe ok",
        },
      },
    ]);
    expect(s.messages).toHaveLength(before);
    expect(s.feed.some((f) => f.line.includes("recovered primary"))).toBe(true);
  });
});
