import { describe, expect, it } from "vitest";
import { createInitialTuiState, type TuiSessionInfo, type ToolCardEntry } from "./tui-state.js";
import { findLastStep, formatWhy, type WhyState } from "./why-snapshot-tui.js";

// ATO-34: `/why` explains the agent's last step from data already in memory.

const SESSION: TuiSessionInfo = {
  sessionId: "s1",
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  completionMaxTokens: 2048,
  skillCount: 0,
};

function card(extra: Partial<ToolCardEntry> = {}): ToolCardEntry {
  return {
    id: "c",
    stepIndex: 3,
    tool: "os.fs.read",
    args: { path: "src/a.ts" },
    status: "ok",
    summary: "file body",
    truncated: false,
    startedAt: 100,
    finishedAt: 440,
    ...extra,
  };
}

function base(extra: Partial<WhyState> = {}): WhyState {
  const initial = createInitialTuiState(SESSION);
  return {
    messages: initial.messages,
    streamingToolCards: initial.streamingToolCards,
    reasoning: initial.reasoning,
    metrics: initial.metrics,
    ...extra,
  };
}

describe("/why", () => {
  it("says there is nothing to explain before any step ran", () => {
    expect(formatWhy(base())).toMatch(/no step has run/);
  });

  it("explains the running turn's last finished step with its own reasoning and tokens", () => {
    const state = base({
      streamingToolCards: [card({ stepIndex: 1, tool: "os.fs.list", args: {} }), card()],
      reasoning: [
        { id: "r1", stepIndex: 1, text: "list first", timestamp: 0 },
        { id: "r2", stepIndex: 3, text: "need   the\nconfig file", timestamp: 0 },
      ],
      metrics: {
        ...base().metrics,
        promptTokensLast: 12345,
        completionTokensLast: 230,
        llmDurationMsLast: 1800,
      },
    });
    const lines = formatWhy(state).split("\n");
    expect(lines[0]).toMatch(/^Last step: step 4 · /);
    expect(lines[1]).toBe('Called: os.fs.read path="src/a.ts"');
    expect(lines[2]).toBe("Result: ok in 340ms · 9 chars back");
    expect(lines[3]).toBe("Tokens (last model call): 12,345 in · 230 out · model took 1.8s");
    expect(lines[4]).toBe("Why (the model's reasoning for this step): need the config file");
  });

  it("skips reply / finish cards and still-running calls", () => {
    const last = findLastStep(
      base({
        streamingToolCards: [
          card({ id: "real" }),
          card({ id: "reply", tool: "reply" }),
          card({ id: "finish", tool: "finish" }),
          card({ id: "pending", status: "pending" }),
        ],
      }),
    );
    expect(last?.card.id).toBe("real");
  });

  it("falls back to the newest finished turn and labels turn-level reasoning", () => {
    const state = base({
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "ok",
          timestamp: 0,
          toolCards: [card({ status: "error", summary: "nope", truncated: true })],
          reasoningBlocks: ["first idea", "last idea"],
        },
        { id: "m2", role: "system", text: "note", timestamp: 1 },
      ],
    });
    const text = formatWhy(state);
    expect(text).toContain("Result: failed in 340ms · 4 chars back (truncated)");
    expect(text).toContain("Why (the model's last reasoning in that turn): last idea");
  });

  it("does not invent a reason when the model gave none", () => {
    const text = formatWhy(base({ streamingToolCards: [card()] }));
    expect(text).toContain("Why: the model gave no reasoning for this step");
    expect(text).toContain("Tokens: not reported for this turn");
  });
});
