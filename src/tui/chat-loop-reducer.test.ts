import { describe, expect, it } from "vitest";
import { reduceTuiState } from "./agent-event-reducer.js";
import { apply, fakeSession } from "./test-fixtures.js";
import type { TuiAction } from "./tui-action.js";
import {
  canAcceptMessage,
  canTypeMessage,
  createInitialTuiState,
} from "./tui-state.js";

describe("chat loop", () => {
  it("should update inputValue on input_changed", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = reduceTuiState(initial, {
      type: "input_changed",
      value: "open gmail",
    });
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
    });
    expect(canAcceptMessage(running)).toBe(false);
  });

  it("resets feed and runStartedAt on message_submitted but keeps cumulative metrics", () => {
    const initial = createInitialTuiState(fakeSession());
    const ts = Date.now();
    const after = apply(initial, [
      {
        type: "metric",
        sample: { name: "llm.prompt_tokens", value: 500, timestamp: ts },
      },
      { type: "agent_event", event: { type: "step_started", stepIndex: 0 } },
      {
        type: "agent_event",
        event: { type: "loop_completed", reason: "finish" },
      },
      { type: "message_submitted" },
    ]);
    expect(after.status).toBe("running");
    expect(after.feed).toHaveLength(0);
    expect(after.runStartedAt).not.toBeNull();
    expect(after.currentStep).toBe(0);
    expect(after.inputValue).toBe("");
    expect(after.metrics.totalTokens).toBe(500);
    expect(after.runHistory).toHaveLength(1);
  });

  it("allows a full two-turn cycle: message -> run -> idle -> message -> run", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "agent_event", event: { type: "user_message", text: "first" } },
      { type: "message_submitted" },
      { type: "agent_event", event: { type: "step_started", stepIndex: 0 } },
      {
        type: "agent_event",
        event: { type: "loop_completed", reason: "finish" },
      },
      { type: "agent_event", event: { type: "user_message", text: "second" } },
      { type: "message_submitted" },
      { type: "agent_event", event: { type: "step_started", stepIndex: 0 } },
      {
        type: "agent_event",
        event: { type: "loop_completed", reason: "max_steps" },
      },
    ]);
    expect(next.status).toBe("idle");
    expect(next.runHistory.map((h) => h.message)).toEqual(["first", "second"]);
    expect(next.runHistory.map((h) => h.outcome)).toEqual([
      "completed",
      "completed",
    ]);
  });

  it("transitions to quitting on quit_requested", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = reduceTuiState(initial, { type: "quit_requested" });
    expect(next.status).toBe("quitting");
    expect(next.aborting).toBe(true);
  });

  it("accumulates reasoning entries from llm_event", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "message_submitted" },
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

  it("clears reasoning on new message_submitted but keeps prior run history", () => {
    const initial = createInitialTuiState(fakeSession());
    const afterFirstRun = apply(initial, [
      { type: "message_submitted" },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "reasoning", stepIndex: 0, text: "r1" },
        },
      },
      {
        type: "agent_event",
        event: { type: "loop_completed", reason: "finish" },
      },
    ]);
    expect(afterFirstRun.reasoning).toHaveLength(1);

    const afterSecondSubmit = reduceTuiState(afterFirstRun, {
      type: "message_submitted",
    });
    expect(afterSecondSubmit.reasoning).toHaveLength(0);
    expect(afterSecondSubmit.runHistory).toHaveLength(1);
  });

  it("caps reasoning ring buffer", () => {
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
            result: {
              tool: "reply",
              status: "ok",
              summary: "hi",
              truncated: false,
            },
          },
        },
      },
    ]);
    expect(next.currentTurnToolSteps).toBe(0);
  });

  it("surfaces prompt budget and parse repair signals in the feed", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: {
            type: "prompt_captured",
            stepIndex: 0,
            stablePrefixHash: "a".repeat(64),
            tail: "### conversation",
            tokens: { total: 120, stablePrefix: 80, tail: 40 },
            slotId: 0,
            cacheReused: true,
          },
        },
      },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: {
            type: "parse_retry",
            stepIndex: 0,
            attempt: 1,
            reason: "terminal verb 'reply' is forbidden inside a batch",
          },
        },
      },
    ]);
    expect(next.feed.map((entry) => entry.line)).toEqual([
      expect.stringContaining("prompt 120 tok"),
      expect.stringContaining("repair retry 1"),
    ]);
    expect(next.metrics.promptTokensLast).toBe(120);
    expect(next.metrics.promptTailTokensLast).toBe(40);
    expect(next.metrics.parseRetries).toBe(1);
  });

  it("labels batched tool calls in the feed", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = reduceTuiState(initial, {
      type: "agent_event",
      event: {
        type: "llm_event",
        event: {
          type: "tool_call_parsed",
          call: { tool: "os.fs.read", args: { path: "a.ts" } },
          batchIndex: 1,
          batchSize: 3,
        },
      },
    });
    expect(next.feed[0]?.line).toContain("[2/3] os.fs.read");
  });

  it("should compute non-zero durationMs for archived run", async () => {
    const initial = createInitialTuiState(fakeSession());
    const afterSubmit = reduceTuiState(initial, {
      type: "message_submitted",
    });
    await new Promise((r) => setTimeout(r, 5));
    const next = reduceTuiState(afterSubmit, {
      type: "agent_event",
      event: { type: "loop_completed", reason: "finish" },
    });
    expect(next.runHistory[0]?.durationMs).toBeGreaterThan(0);
  });
});

describe("queued submissions", () => {
  it("may be typed while a turn is running", () => {
    const running = reduceTuiState(createInitialTuiState(fakeSession()), {
      type: "message_submitted",
    });
    expect(canAcceptMessage(running)).toBe(false);
    expect(canTypeMessage(running)).toBe(true);
  });

  it("does not wipe the live turn's feed the way message_submitted does", () => {
    // This is the regression the separate action exists for: reusing
    // `message_submitted` for a mid-run send called startNewRun and
    // blanked the screen the operator was reading.
    const initial = createInitialTuiState(fakeSession());
    const running = apply(initial, [
      { type: "message_submitted" },
      { type: "agent_event", event: { type: "step_started", stepIndex: 0 } },
      { type: "assistant_delta", text: "partial answer" },
    ]);
    expect(running.feed.length).toBeGreaterThan(0);

    const afterQueue = reduceTuiState(running, {
      type: "message_queued",
      text: "one more thing",
    });

    expect(afterQueue.feed).toEqual(running.feed);
    expect(afterQueue.streamingAssistantText).toBe("partial answer");
    expect(afterQueue.status).toBe("running");
    expect(afterQueue.queuedMessages).toEqual(["one more thing"]);
    expect(afterQueue.inputValue).toBe("");
  });
});
