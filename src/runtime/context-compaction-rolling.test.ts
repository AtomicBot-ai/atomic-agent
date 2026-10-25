import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../config/index.js";
import { createCompactionDefaults, type CompactionConfig } from "../config/agent/compaction-config.js";
import { createEmptySessionState, recordTurn, type SessionState } from "../session/session-state.js";
import { assistantToolCallTurn, toolResultTurn, userTurn } from "../session/conversation-turn.js";
import { compactionBoundaryHash, safeCompactionCuts } from "../session/session-compaction.js";
import { buildPrompt } from "../prompt/build-prompt.js";
import { estimateTokens } from "../prompt/token-budget.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import type { CompletionResult } from "../llm/provider/completion-types.js";
import type { LlmStreamParams } from "../agent/step/step-contract.js";
import { createBackgroundCompaction } from "./compaction-background.js";
import type { CompactionRouteFacts } from "./compaction-mode.js";
import { createContextCompaction } from "./context-compaction.js";
import { TurnController } from "./turn-controller.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "context-compaction-rolling-"));
  vi.stubEnv("ATOMIC_AGENT_STATE_DIR", dir);
  resetConfigCache();
});
afterEach(() => { vi.unstubAllEnvs(); resetConfigCache(); rmSync(dir, { recursive: true, force: true }); });

const ROLLING = "Goal: preserve the green button. Done: read the early files.";
function completion(content = ROLLING): CompletionResult {
  return { content, reasoningContent: "", stop: true, truncated: false, timing: { promptTokens: 100, predictedTokens: 30, promptMs: 1, predictedMs: 1 }, cacheHitTokens: 0, slotId: 3, modelId: "bg-model" };
}
function history(steps = 22, from?: SessionState) {
  let state = from ?? recordTurn(createEmptySessionState({ id: "chat", workingDir: dir }), userTurn("ORIGINAL: preserve the green button"));
  const offset = from ? from.turns.length : 0;
  for (let i = offset; i < offset + steps; i++) {
    state = recordTurn(state, assistantToolCallTurn({ tool: "os.fs.read", args: { path: `/file-${i}` } }));
    state = recordTurn(state, toolResultTurn({ tool: "os.fs.read", status: "ok", summary: `result ${i}: ${"important details ".repeat(150)}` }));
  }
  return state;
}
function input(session: SessionState): BuildPromptInput {
  return { session, toolDescriptors: [], skillCatalog: [], profile: PLAIN_INSTRUCT_PROFILE,
    contextWindow: 12000, conversationMaxTokens: 4000, conversationMaxPairs: 200,
    capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: dir, hasClipboard: false, hasWmctrl: false, hasNotifications: false } };
}
function fixture(options: { state?: SessionState; facts?: CompactionRouteFacts; slot?: number; config?: Partial<CompactionConfig> } = {}) {
  let stored = options.state ?? history();
  const config: CompactionConfig = { ...createCompactionDefaults(), summaryMaxTokens: 250, ...options.config };
  const complete = vi.fn(async (_params: LlmStreamParams) => completion());
  const save = vi.fn((next: SessionState) => { stored = next; });
  const route = vi.fn((_id: string, providerId?: string) => ({ providerId: providerId ?? "current", transport: "grammar" as const, serverTemplate: true, ...options.facts }));
  const turnController = new TurnController();
  const sessionStore = { load: (id: string) => id === stored.id ? stored : null, save };
  const sideCallSlotId = () => options.slot ?? 3;
  const isIdle = vi.fn(() => turnController.busySessionIds().length === 0);
  const background = createBackgroundCompaction({ config: () => config, sessionStore, complete, route, sideCallSlotId,
    promptInput: input, isIdle, isBusy: (id) => turnController.isBusy(id), delayMs: 0 });
  const service = createContextCompaction({ config: () => config, sessionStore, turnController, complete, route, sideCallSlotId,
    persist: save, emit: () => {}, promptInput: input, background });
  return { ...service, complete, save, config, background, isIdle, stored: () => stored, set: (next: SessionState) => { stored = next; } };
}
/** Lets zero-delay timers and the job's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
/** Waits until follow-up jobs stop moving the watermark, then stops the scheduler. */
async function quiesce(f: { stored(): SessionState; background: { shutdown(): void } }) {
  let last = -1;
  for (let i = 0; i < 100; i++) {
    await settle();
    const now = f.stored().rollingSummary?.coveredThrough ?? 0;
    if (now > 0 && now === last) break;
    last = now;
  }
  f.background.shutdown();
}
function hanging(f: ReturnType<typeof fixture>) {
  f.complete.mockImplementation(() => new Promise<CompletionResult>(() => {}));
}

describe("background rolling summary", () => {
  it("is built after a turn ends, then a compaction uses it with no model call and appends the newest records", async () => {
    const f = fixture({ facts: { local: true, prefixReuse: "partial" } });
    f.control.close("chat");
    await quiesce(f);
    const rolling = f.stored().rollingSummary!;
    expect(f.complete.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.complete.mock.calls[0]![0]).toMatchObject({ slotId: 3, sessionId: "compaction:chat", providerId: "current" });
    expect(rolling).toMatchObject({ summary: ROLLING, from: 0, model: "bg-model" });
    expect(safeCompactionCuts(f.stored().turns)).toContain(rolling.coveredThrough);
    // The next turn adds records the rolling summary has not seen.
    f.set(history(6, f.stored()));
    f.complete.mockClear();
    const started = performance.now();
    expect(await f.compactSession("chat")).toMatchObject({ status: "compacted" });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(f.complete).not.toHaveBeenCalled();
    const checkpoint = f.stored().compaction!;
    expect(checkpoint).toMatchObject({ kind: "rolling", model: "bg-model", calls: 0 });
    expect(checkpoint.summary.startsWith(ROLLING)).toBe(true);
    expect(checkpoint.coveredThrough).toBeGreaterThan(rolling.coveredThrough);
    expect(checkpoint.summary).toContain(`Extractive summary of conversation records ${rolling.coveredThrough}-`);
    const lastCall = f.stored().turns[checkpoint.coveredThrough - 2]!;
    expect(lastCall.kind).toBe("assistant_tool_call");
    expect(checkpoint.summary).toContain(lastCall.kind === "assistant_tool_call" ? String(lastCall.args.path) : "?");
    expect(f.stored()).not.toHaveProperty("rollingSummary");
  });

  it("ignores a stale rolling summary and compacts as before", async () => {
    const f = fixture();
    f.control.close("chat");
    await vi.waitFor(() => expect(f.stored().rollingSummary).toBeDefined());
    f.background.shutdown();
    const stale = f.stored();
    f.set({ ...stale, rollingSummary: { ...stale.rollingSummary!, boundaryHash: compactionBoundaryHash(userTurn("other")) } });
    f.complete.mockClear();
    f.complete.mockResolvedValue(completion("Goal: preserve the green button. Model summary at compaction time."));
    expect(await f.compactSession("chat")).toMatchObject({ status: "compacted" });
    expect(f.complete).toHaveBeenCalled();
    expect(f.stored().compaction).not.toHaveProperty("kind");
    expect(f.stored().compaction!.summary).toContain("Model summary at compaction time.");
  });

  it("does not start on a local route whose only slot is the main one", async () => {
    const f = fixture({ facts: { local: true, prefixReuse: "none" }, slot: -1 });
    f.control.close("chat");
    await settle();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    const control = fixture({ facts: { local: true, prefixReuse: "none" }, slot: 2 });
    control.control.close("chat");
    await vi.waitFor(() => expect(control.complete).toHaveBeenCalled());
    expect(control.complete.mock.calls[0]![0].slotId).toBe(2);
    control.shutdown();
  });

  it("is cancelled when a turn starts and nothing is written", async () => {
    const f = fixture();
    hanging(f);
    f.control.close("chat");
    await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(1));
    const signal = f.complete.mock.calls[0]![0].signal!;
    expect(signal.aborted).toBe(false);
    f.control.open("chat", new AbortController().signal);
    expect(signal.aborted).toBe(true);
    await settle();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.stored()).not.toHaveProperty("rollingSummary");
  });

  it("is cancelled on shutdown, including a job still waiting for its timer", async () => {
    const f = fixture();
    hanging(f);
    f.control.close("chat");
    await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(1));
    const signal = f.complete.mock.calls[0]![0].signal!;
    f.shutdown();
    expect(signal.aborted).toBe(true);
    f.background.schedule("chat");
    await settle();
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.save).not.toHaveBeenCalled();
    const waiting = fixture();
    waiting.control.close("chat");
    waiting.shutdown();
    await settle();
    // The timer was cleared: the job never even checked whether the runtime was idle.
    expect(waiting.isIdle).not.toHaveBeenCalled();
    expect(waiting.complete).not.toHaveBeenCalled();
  });

  it("reads a bounded slice of new records per job and continues where it stopped", async () => {
    const f = fixture({ state: history(60) });
    f.control.close("chat");
    await vi.waitFor(() => expect(f.complete.mock.calls.length).toBeGreaterThanOrEqual(2));
    f.background.shutdown();
    const records = (call: number) => {
      const prompt = f.complete.mock.calls[call]![0].prompt;
      return prompt.slice(prompt.indexOf("New conversation records"));
    };
    const first = records(0);
    expect(first).toContain("Record 0: user: ORIGINAL: preserve the green button");
    // Rendered as history, never as raw JSON records, and within the job's input cap.
    expect(first).not.toContain('"kind"');
    expect(estimateTokens(first)).toBeLessThan(5_500);
    const last = Math.max(...[...first.matchAll(/^Record (\d+):/gm)].map((match) => Number(match[1])));
    const second = records(1);
    expect(second).toContain(`Record ${last + 1}: `);
    expect(second).not.toContain(`Record ${last}: `);
    expect(f.complete.mock.calls[1]![0].prompt).toContain(`Previous summary:\n${ROLLING}`);
  });

  it("on a cloud route waits for half the history allowance; a local route starts earlier; config can turn it off", async () => {
    // Grow history in small steps until it fills 30-45% of the allowance.
    const grow = (from: SessionState) => recordTurn(recordTurn(from,
      assistantToolCallTurn({ tool: "os.fs.read", args: { path: `/small-${from.turns.length}` } })),
      toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "detail ".repeat(20) }));
    let state = grow(recordTurn(createEmptySessionState({ id: "chat", workingDir: dir }), userTurn("ORIGINAL: preserve the green button")));
    const fill = (s: SessionState) => { const b = buildPrompt(input(s)).compactionBudget!; return b.activeTokens / b.cap; };
    while (fill(state) < 0.3) state = grow(state);
    const ratio = fill(state);
    expect(ratio).toBeLessThan(0.45);
    const config = { triggerRatio: Math.min(0.95, ratio * 1.5), targetRatio: Math.min(0.95, ratio * 1.5) / 2 };
    const cloud = fixture({ state, config });
    cloud.control.close("chat");
    await settle();
    expect(cloud.complete).not.toHaveBeenCalled();
    const local = fixture({ state, config, facts: { local: true, prefixReuse: "partial" } });
    local.control.close("chat");
    await vi.waitFor(() => expect(local.complete).toHaveBeenCalled());
    const full = fixture();
    full.control.close("chat");
    await vi.waitFor(() => expect(full.complete).toHaveBeenCalled());
    const off = fixture({ config: { background: false } });
    off.control.close("chat");
    await settle();
    expect(off.complete).not.toHaveBeenCalled();
    for (const each of [cloud, local, full, off]) each.shutdown();
  });
});
