import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../config/index.js";
import { createCompactionDefaults } from "../config/agent/compaction-config.js";
import { createEmptySessionState, recordTurn, type SessionState } from "../session/session-state.js";
import { assistantToolCallTurn, toolResultTurn, userTurn } from "../session/conversation-turn.js";
import { renderPackedConversation } from "./build-prompt-world-conversation.js";
import type { BuiltPrompt } from "./build-prompt-types.js";
import { decideCompaction, EXACT_COUNT_TRIGGER_BAND, exactCountCandidate, NO_PREFIX_REUSE_TARGET_RATIO } from "./plan-compaction.js";
import { estimateTokens } from "./token-budget.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plan-compaction-"));
  vi.stubEnv("ATOMIC_AGENT_STATE_DIR", dir);
  resetConfigCache();
});
afterEach(() => { vi.unstubAllEnvs(); resetConfigCache(); rmSync(dir, { recursive: true, force: true }); });

/** One task with several small tool steps and a large newest one, as on a 16k local model. */
function session(): SessionState {
  let state = recordTurn(createEmptySessionState({ id: "small", workingDir: dir }), userTurn("Fix the failing test"));
  for (let i = 0; i < 6; i++) {
    state = recordTurn(state, assistantToolCallTurn({ tool: "os.fs.read", args: { path: `/src/file-${i}.ts` } }));
    state = recordTurn(state, toolResultTurn({ tool: "os.fs.read", status: "ok", summary: `file ${i}: ${"line ".repeat(120)}` }));
  }
  state = recordTurn(state, assistantToolCallTurn({ tool: "os.fs.read", args: { path: "/src/big.ts" } }));
  return recordTurn(state, toolResultTurn({ tool: "os.fs.read", status: "ok", summary: `big: ${"detail ".repeat(520)}` }));
}

/** The prompt facts the planner reads, with a history allowance of `cap` tokens nearly full. */
function promptWithCap(cap: number): BuiltPrompt {
  return { compactionBudget: { cap, activeTokens: Math.ceil(cap * 0.95), activePairs: 1 }, conversationPairsCap: 200 } as unknown as BuiltPrompt;
}

describe("planning on a small window without prefix reuse (ATO-257, ATO-1117)", () => {
  it("falls back to the configured target when the smaller no-reuse tail fits no cut", () => {
    const state = session();
    const newestStep = estimateTokens(renderPackedConversation({ visibleTurns: state.turns.slice(-2), droppedSummary: null }));
    // The newest step alone is too big for the 0.35 tail but fits the 0.65 one.
    const cap = Math.ceil(newestStep / 0.3);
    const prompt = promptWithCap(cap);
    const config = createCompactionDefaults();
    expect(decideCompaction(state, prompt, { ...config, targetRatio: NO_PREFIX_REUSE_TARGET_RATIO })).toMatchObject({ plan: null, skip: "no_reduction" });

    const decision = decideCompaction(state, prompt, config, undefined, { prefixReuse: "none" });
    expect(decision.plan).not.toBeNull();
    expect(decision.plan!.targetTokens).toBe(Math.floor(config.targetRatio * cap));
    expect(decision.plan!.through).toBeLessThanOrEqual(state.turns.length - 2);
    // Same plan as a route with prefix reuse would get.
    expect(decision).toEqual(decideCompaction(state, prompt, config, undefined, { prefixReuse: "partial" }));
  });

  it("keeps the smaller target whenever it fits", () => {
    const state = session();
    const prompt = promptWithCap(20_000);
    const config = createCompactionDefaults();
    const decision = decideCompaction(state, prompt, config, undefined, { prefixReuse: "none" });
    expect(decision.plan!.targetTokens).toBe(Math.floor(NO_PREFIX_REUSE_TARGET_RATIO * 20_000));
  });

  it("does not retry when compaction is not due, and a lower configured ratio is never widened", () => {
    const state = session();
    const config = createCompactionDefaults();
    const idle = { compactionBudget: { cap: 4000, activeTokens: 100, activePairs: 1 }, conversationPairsCap: 200 } as unknown as BuiltPrompt;
    expect(decideCompaction(state, idle, config, undefined, { prefixReuse: "none" })).toEqual({ plan: null });
    const newestStep = estimateTokens(renderPackedConversation({ visibleTurns: state.turns.slice(-2), droppedSummary: null }));
    const prompt = promptWithCap(Math.ceil(newestStep / 0.3));
    const lower = { ...config, targetRatio: 0.3 };
    expect(decideCompaction(state, prompt, lower, undefined, { prefixReuse: "none" }).plan).toBeNull();
  });
});

describe("exact token count at the automatic trigger (ATO-656)", () => {
  const config = createCompactionDefaults();
  /** A prompt whose heuristic history size is `share` of the automatic trigger. */
  function promptAt(share: number, cap = 20_000, extra: Partial<BuiltPrompt> = {}): BuiltPrompt {
    const activeTokens = Math.ceil(cap * config.triggerRatio * share);
    return { compactionBudget: { cap, activeTokens, activePairs: 1 }, conversationPairsCap: 200, ...extra } as unknown as BuiltPrompt;
  }

  it("asks for the history text only when the estimate is near the trigger", () => {
    const state = session();
    const text = exactCountCandidate(state, promptAt(1.05), config);
    expect(text).toBe(renderPackedConversation({ visibleTurns: state.turns, droppedSummary: null }));
    expect(exactCountCandidate(state, promptAt(EXACT_COUNT_TRIGGER_BAND.low), config)).not.toBeNull();
    expect(exactCountCandidate(state, promptAt(EXACT_COUNT_TRIGGER_BAND.high - 0.01), config)).not.toBeNull();
    expect(exactCountCandidate(state, promptAt(EXACT_COUNT_TRIGGER_BAND.low - 0.05), config)).toBeNull();
    expect(exactCountCandidate(state, promptAt(EXACT_COUNT_TRIGGER_BAND.high + 0.05), config)).toBeNull();
  });

  it("leaves requested, disabled, pair-capped and cloud decisions to the heuristic", () => {
    const state = session();
    expect(exactCountCandidate(state, promptAt(1), config, "manual")).toBeNull();
    expect(exactCountCandidate(state, promptAt(1), config, "overflow")).toBeNull();
    expect(exactCountCandidate(state, promptAt(1), { ...config, auto: false })).toBeNull();
    expect(exactCountCandidate(state, promptAt(1, 20_000, { conversationPairsCap: 0 }), config)).toBeNull();
    expect(exactCountCandidate(state, promptAt(1, 20_000, { cloudContext: {} } as unknown as Partial<BuiltPrompt>), config)).toBeNull();
    expect(exactCountCandidate(state, { conversationPairsCap: 200 } as unknown as BuiltPrompt, config)).toBeNull();
  });

  it("skips a compaction the over-counting estimate made due", () => {
    const state = session();
    const prompt = promptAt(1.05);
    expect(decideCompaction(state, prompt, config).plan).not.toBeNull();
    const exact = Math.floor(prompt.compactionBudget!.activeTokens * 0.88);
    expect(decideCompaction(state, prompt, config, undefined, { measuredActiveTokens: exact })).toEqual({ plan: null });
  });

  it("compacts when the exact count reaches the trigger the estimate missed", () => {
    const state = session();
    const prompt = promptAt(0.9);
    expect(decideCompaction(state, prompt, config)).toEqual({ plan: null });
    const exact = Math.ceil(prompt.compactionBudget!.activeTokens * 1.15);
    const decision = decideCompaction(state, prompt, config, undefined, { measuredActiveTokens: exact });
    expect(decision.plan).toMatchObject({ reason: "threshold", tokensBefore: prompt.compactionBudget!.activeTokens });
  });

  it("does not let a measured size stop a requested compaction", () => {
    const state = session();
    const prompt = promptAt(1.05);
    expect(decideCompaction(state, prompt, config, "overflow", { measuredActiveTokens: 1 }).plan).toMatchObject({ reason: "overflow" });
  });
});
