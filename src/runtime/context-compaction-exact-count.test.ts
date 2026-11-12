import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../config/index.js";
import { createCompactionDefaults, type CompactionConfig } from "../config/agent/compaction-config.js";
import { createEmptySessionState, recordTurn, type SessionState } from "../session/session-state.js";
import { assistantToolCallTurn, toolResultTurn, userTurn } from "../session/conversation-turn.js";
import { buildPrompt } from "../prompt/build-prompt.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import { exactCountCandidate } from "../prompt/plan-compaction.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import type { CompletionResult } from "../llm/provider/completion-types.js";
import type { TokenCounter } from "../llm/token-counter.js";
import type { LlmStreamParams } from "../agent/step/step-contract.js";
import { createContextCompaction } from "./context-compaction.js";
import { TurnController } from "./turn-controller.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-exact-count-"));
  vi.stubEnv("ATOMIC_AGENT_STATE_DIR", dir);
  resetConfigCache();
});
afterEach(() => { vi.unstubAllEnvs(); resetConfigCache(); rmSync(dir, { recursive: true, force: true }); });

function completion(): CompletionResult {
  return { content: "Goal: finish the task. Constraints: keep the original requirements. Completed: the reads. Next: continue.", reasoningContent: "", stop: true, truncated: false,
    timing: { promptTokens: 100, predictedTokens: 30, promptMs: 1, predictedMs: 1 }, cacheHitTokens: 0, slotId: -1, modelId: "test-model",
    usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 } };
}
function history(steps: number): SessionState {
  let state = recordTurn(createEmptySessionState({ id: "chat", workingDir: dir }), userTurn("ORIGINAL: preserve the green button"));
  for (let i = 0; i < steps; i++) {
    state = recordTurn(state, assistantToolCallTurn({ tool: "os.fs.read", args: { path: `/file-${i}` } }));
    state = recordTurn(state, toolResultTurn({ tool: "os.fs.read", status: "ok", summary: `result ${i}: ${"important details ".repeat(150)}` }));
  }
  return state;
}
function input(session: SessionState): BuildPromptInput {
  return { session, toolDescriptors: [], skillCatalog: [], profile: PLAIN_INSTRUCT_PROFILE,
    contextWindow: 32000, conversationMaxTokens: 8000, conversationMaxPairs: 200,
    capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: dir, hasClipboard: false, hasWmctrl: false, hasNotifications: false } };
}
const config: CompactionConfig = { ...createCompactionDefaults(), mode: "model", summaryMaxTokens: 250 };

/** The shortest history whose estimate has just reached the automatic trigger, so an exact count is asked for. */
function justDue(): { state: SessionState; trigger: number } {
  for (let steps = 1; steps < 60; steps++) {
    const state = history(steps);
    const prompt = buildPrompt(input(state));
    const budget = prompt.compactionBudget!;
    const trigger = budget.cap * config.triggerRatio;
    if (budget.activeTokens >= trigger) {
      expect(exactCountCandidate(state, prompt, config)).not.toBeNull();
      return { state, trigger };
    }
  }
  throw new Error("no history reached the trigger");
}

function fixture(state: SessionState, tokenCounter?: () => TokenCounter | undefined) {
  const complete = vi.fn(async (_params: LlmStreamParams) => completion());
  const route = vi.fn((_id: string, providerId?: string) => ({ providerId: providerId ?? "current", transport: "grammar" as const, serverTemplate: true }));
  const service = createContextCompaction({
    config: () => config, sessionStore: { load: (id) => id === state.id ? state : null }, turnController: new TurnController(),
    complete, route, persist: vi.fn(), emit: vi.fn(), sideCallSlotId: () => 3, promptInput: input,
    ...(tokenCounter ? { tokenCounter } : {}),
  });
  return { ...service, complete };
}

const signal = () => new AbortController().signal;

describe("automatic compaction with an exact token count (ATO-656)", () => {
  it("skips the compaction when the exact count is under the trigger the estimate reached", async () => {
    const { state, trigger } = justDue();
    const count = vi.fn(async () => Math.floor(trigger * 0.7));
    const f = fixture(state, () => ({ count }));
    const pending = f.control.beforeStep(input(state), { signal: signal() });
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toBe(state);
    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0]![0]).toBe(exactCountCandidate(state, buildPrompt(input(state)), config));
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("compacts as before when the exact count confirms the estimate", async () => {
    const { state, trigger } = justDue();
    const f = fixture(state, () => ({ count: async () => Math.ceil(trigger) }));
    const next = await f.control.beforeStep(input(state), { signal: signal() });
    expect(f.complete).toHaveBeenCalled();
    expect(next?.compaction).toBeDefined();
  });

  it("falls back to the estimate when the counter has no answer or fails", async () => {
    const { state } = justDue();
    const silent = fixture(state, () => ({ count: async () => null }));
    expect((await silent.control.beforeStep(input(state), { signal: signal() }))?.compaction).toBeDefined();
    const broken = fixture(state, () => ({ count: () => Promise.reject(new Error("boom")) }));
    expect((await broken.control.beforeStep(input(state), { signal: signal() }))?.compaction).toBeDefined();
    const throwing = fixture(state, () => { throw new Error("no route"); });
    expect((await throwing.control.beforeStep(input(state), { signal: signal() }))?.compaction).toBeDefined();
  });

  it("decides on the estimate alone on a route without a counter", async () => {
    const { state } = justDue();
    const f = fixture(state, () => undefined);
    expect((await f.control.beforeStep(input(state), { signal: signal() }))?.compaction).toBeDefined();
  });

  it("does not ask while history is far from the trigger", () => {
    const state = history(1);
    const count = vi.fn(async () => 1);
    const f = fixture(state, () => ({ count }));
    expect(f.control.beforeStep(input(state), { signal: signal() })).toBeUndefined();
    expect(count).not.toHaveBeenCalled();
  });

  it("does not compact after the step was cancelled during the count", async () => {
    const { state } = justDue();
    const controller = new AbortController();
    const f = fixture(state, () => ({ count: async () => { controller.abort(); return null; } }));
    expect(await f.control.beforeStep(input(state), { signal: controller.signal })).toBe(state);
    expect(f.complete).not.toHaveBeenCalled();
  });
});
