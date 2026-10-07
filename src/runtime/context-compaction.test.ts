import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, resetConfigCache } from "../config/index.js";
import { createCompactionDefaults, parseCompactionConfig } from "../config/agent/compaction-config.js";
import { createEmptySessionState, recordTurn, type SessionState } from "../session/session-state.js";
import { assistantReplyTurn, assistantToolCallTurn, toolResultTurn, userTurn, steeredUserTurn } from "../session/conversation-turn.js";
import { normalizeSessionState } from "../session/normalize-session-state.js";
import { compactionBoundaryHash, projectSessionConversation, safeCompactionCuts, validSessionCompaction } from "../session/session-compaction.js";
import { buildPrompt } from "../prompt/build-prompt.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import { planCompaction } from "../prompt/plan-compaction.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import type { CompletionResult } from "../llm/provider/completion-types.js";
import { buildNativeMessages } from "../llm/provider/openai/openai-native-messages.js";
import { createContextCompaction } from "./context-compaction.js";
import { TurnController } from "./turn-controller.js";
import type { CompactionEvent } from "../agent/compaction-control.js";
import { estimateTokens } from "../prompt/token-budget.js";
import { planCompactionChunks, prepareCompactionSource } from "./context-compaction-chunks.js";
import type { LlmStreamParams } from "../agent/step/step-contract.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "context-compaction-"));
  vi.stubEnv("ATOMIC_AGENT_STATE_DIR", dir);
  resetConfigCache();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); resetConfigCache(); rmSync(dir, { recursive: true, force: true }); });

function completion(content = "Goal: finish the task. Constraints: keep the original requirements. Completed: the recorded reads succeeded. Next: continue the unfinished work."): CompletionResult {
  return { content, reasoningContent: "", stop: true, truncated: false, timing: { promptTokens: 100, predictedTokens: 30, promptMs: 1, predictedMs: 1 }, cacheHitTokens: 0, slotId: -1, modelId: "test-model", usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 } };
}
function history(steps = 22, closed = false) {
  let state = recordTurn(createEmptySessionState({ id: "chat", workingDir: dir }), userTurn("ORIGINAL: preserve the green button and do not deploy"));
  for (let i = 0; i < steps; i++) {
    state = recordTurn(state, assistantToolCallTurn({ tool: "os.fs.read", args: { path: `/file-${i}` } }));
    state = recordTurn(state, toolResultTurn({ tool: "os.fs.read", status: "ok", summary: `result ${i}: ${"important details ".repeat(150)}` }));
    if (closed) {
      state = recordTurn(state, assistantReplyTurn(`done ${i}`));
      state = recordTurn(state, userTurn(`next task ${i}`));
    }
  }
  return state;
}
function input(session: SessionState): BuildPromptInput {
  return { session, toolDescriptors: [], skillCatalog: [], profile: PLAIN_INSTRUCT_PROFILE,
    contextWindow: 12000, conversationMaxTokens: 4000, conversationMaxPairs: 200,
    capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: dir, hasClipboard: false, hasWmctrl: false, hasNotifications: false } };
}
function fixture(state = history()) {
  let stored = state;
  const config = { ...createCompactionDefaults(), summaryMaxTokens: 250 };
  const events: CompactionEvent[] = [];
  const complete = vi.fn(async (_params: LlmStreamParams) => completion());
  const persist = vi.fn((next: SessionState) => { stored = next; });
  const route = vi.fn((_id: string, providerId?: string) => ({ providerId: providerId ?? "current", transport: "grammar" as const, serverTemplate: true }));
  const turnController = new TurnController();
  const service = createContextCompaction({
    config: () => config, sessionStore: { load: (id) => id === state.id ? stored : null }, turnController,
    complete, route, persist, emit: (event) => events.push(event), sideCallSlotId: () => 3, promptInput: input,
  });
  return { ...service, complete, persist, events, config, route, turnController, stored: () => stored };
}

describe("compaction configuration and projection", () => {
  it("defaults old config and rejects invalid ratios", () => {
    expect(getConfig().agent.compaction).toEqual(createCompactionDefaults());
    expect(parseCompactionConfig(undefined, createCompactionDefaults())).toEqual(createCompactionDefaults());
    expect(createCompactionDefaults()).toMatchObject({ timeoutMs: 600000, maxTotalTimeoutMs: 600000 });
    expect(parseCompactionConfig({ timeoutMs: 120000 }, createCompactionDefaults())).toMatchObject({ timeoutMs: 120000, maxTotalTimeoutMs: 600000 });
    for (const raw of [{ targetRatio: 0 }, { targetRatio: .95 }, { triggerRatio: 1 }, { timeoutMs: 0 }, { maxTotalTimeoutMs: -1 }]) {
      expect(() => parseCompactionConfig(raw, createCompactionDefaults())).toThrow();
    }
  });
  it("ignores damaged checkpoints with a diagnostic and leaves old sessions intact", () => {
    const state = history();
    expect(normalizeSessionState(state).compaction).toBeUndefined();
    const invalid = normalizeSessionState({ ...state, compaction: { version: 1, summary: "bad", coveredThrough: 100000 } });
    expect(invalid.compaction).toBeUndefined();
    expect(invalid.compactionWarning).toContain("invalid");
    expect(invalid.turns).toEqual(state.turns);
  });
  it("never cuts between calls and results, including grouped batches", () => {
    const turns = history(2).turns;
    expect(safeCompactionCuts(turns)).toEqual([1, 3, 5]);
    expect(safeCompactionCuts([turns[0]!, turns[1]!, turns[3]!, turns[2]!, turns[4]!])).toEqual([1, 5]);
  });
  it("triggers before pair trimming, honours auto off and no useful reduction", () => {
    const state = history(8, true);
    const prompt = buildPrompt({ ...input(state), conversationMaxPairs: 2, conversationMaxTokens: 50000, contextWindow: 100000 });
    const config = createCompactionDefaults();
    expect(planCompaction(state, prompt, config)?.reason).toBe("pairs");
    expect(planCompaction(state, prompt, { ...config, auto: false })).toBeNull();
    expect(planCompaction(history(0), buildPrompt(input(history(0))), config, "manual")).toBeNull();
  });
  it("uses inclusive token thresholds, rebudgets a smaller model and tolerates unknown windows", () => {
    const state = history();
    const prompt = buildPrompt(input(state));
    const config = createCompactionDefaults();
    const budget = prompt.compactionBudget!;
    expect(planCompaction(state, { ...prompt, compactionBudget: { ...budget, activeTokens: budget.cap * .9 - 1 } }, config)).toBeNull();
    expect(planCompaction(state, { ...prompt, compactionBudget: { ...budget, activeTokens: budget.cap * .9 } }, config)?.reason).toBe("threshold");
    const tiny = buildPrompt({ ...input(state), contextWindow: 1000 });
    expect(planCompaction(state, tiny, config)).toBeNull();
    const unknown = buildPrompt({ ...input(state), contextWindow: null });
    expect(planCompaction(state, unknown, config, "manual")).not.toBeNull();
    const hugeLast = recordTurn(state, userTurn("x".repeat(100000)));
    expect(planCompaction(hugeLast, buildPrompt(input(hugeLast)), config, "manual")).toBeNull();
  });
});

describe("atomic compaction", () => {
  it("preserves transcript and task request, shares flat/native projection, and keeps prefix stable", async () => {
    const state = history();
    const before = structuredClone(state);
    const f = fixture(state);
    expect((await f.compactSession(state.id)).status).toBe("compacted");
    const next = f.stored();
    expect(next.turns).toEqual(before.turns);
    expect(next.stepCount).toBe(before.stepCount);
    expect(next.turnCount).toBe(before.turnCount);
    expect(validSessionCompaction(normalizeSessionState(JSON.parse(JSON.stringify(next))))).not.toBeNull();
    const prompt = buildPrompt(input(next));
    expect(prompt.stablePrefix).toBe(buildPrompt(input(before)).stablePrefix);
    expect(prompt.text).toContain("ORIGINAL: preserve the green button and do not deploy");
    const native = buildNativeMessages(prompt.messages, { nameEscape: (s) => s });
    expect(JSON.stringify(native)).toContain(next.compaction!.summary);
    expect(prompt.messages.contextSummary).toBe(projectSessionConversation(next).summary);
    expect(prompt.tokens.compaction).toBeGreaterThan(0);
    const grown = recordTurn(next, steeredUserTurn("LATEST: also preserve keyboard shortcuts"));
    expect(buildPrompt(input(grown)).text).toContain("LATEST: also preserve keyboard shortcuts");
    expect(grown.compaction).toEqual(next.compaction);
    const wrong = { ...next, compaction: { ...next.compaction!, boundaryHash: "bad" } };
    expect(validSessionCompaction(wrong)).toBeNull();
    const split = { ...next, compaction: { ...next.compaction!, coveredThrough: 2, boundaryHash: compactionBoundaryHash(next.turns[1]!) } };
    expect(validSessionCompaction(split)).toBeNull();
  });
  it("chunks the original transcript including previously hidden records, then merges the old checkpoint", async () => {
    const state = history();
    state.conversationPackStart = { index: 31, at: state.turns[31]!.at, boundBy: "tokens" };
    const f = fixture(state);
    await f.compactSession(state.id);
    expect(f.complete.mock.calls.length).toBeGreaterThan(1);
    const sent = f.complete.mock.calls as unknown as Array<[{ prompt: string; tools?: unknown; providerId?: string; chat?: unknown }]>;
    expect(sent[0]![0].prompt).toContain("/file-0");
    expect(sent.every(([p]) => p.tools === undefined && p.providerId === "current" && p.chat)).toBe(true);
    expect(sent[1]![0].prompt).toContain("Previous summary:\nGoal:");
    expect(f.persist).toHaveBeenCalledTimes(1);
    const old = f.stored();
    let grown = old;
    for (const t of history(12).turns.slice(1)) grown = recordTurn(grown, t);
    f.control.open(grown.id, new AbortController().signal);
    const result = await f.control.beforeStep(input(grown), { signal: new AbortController().signal, providerId: "pinned", ephemeral: true });
    expect(result!.compaction!.coveredThrough).toBeGreaterThan(old.compaction!.coveredThrough);
    expect(f.route).toHaveBeenLastCalledWith(grown.id, "pinned");
    expect(f.persist).toHaveBeenCalledTimes(1);
    f.control.close(grown.id);
  });
  it.each(["empty", "truncated", "oversized", "throw", "write"])("keeps old state on %s failure and disables auto until next turn", async (failure) => {
    const state = history();
    const f = fixture(state);
    if (failure === "empty") f.complete.mockResolvedValue(completion(""));
    if (failure === "truncated") f.complete.mockResolvedValue({ ...completion(), truncated: true });
    if (failure === "oversized") f.complete.mockResolvedValue(completion("x".repeat(5000)));
    if (failure === "throw") f.complete.mockRejectedValue(new Error("provider down"));
    if (failure === "write") f.persist.mockImplementation(() => { throw new Error("disk full"); });
    const signal = new AbortController().signal;
    f.control.open(state.id, signal);
    const next = await f.control.beforeStep(input(state), { signal });
    expect(next).toBe(state);
    expect(f.events.at(-1)?.type).toBe("compaction_failed");
    const calls = f.complete.mock.calls.length;
    expect(f.control.beforeStep(input(state), { signal })).toBeUndefined();
    expect(f.complete).toHaveBeenCalledTimes(calls);
    f.control.close(state.id);
    f.control.open(state.id, signal);
    await f.control.beforeStep(input(state), { signal });
    expect(f.complete.mock.calls.length).toBeGreaterThan(calls);
    f.control.close(state.id);
  });
  it("bounds a provider ignoring timeout without publishing a checkpoint", async () => {
    const f = fixture(); f.config.timeoutMs = 10;
    f.complete.mockImplementation(() => new Promise(() => {}));
    expect(await f.compactSession("chat")).toMatchObject({ status: "failed", message: expect.stringContaining("part 1/") });
    expect(f.persist).not.toHaveBeenCalled();
  });
  it("bounds chunked input to the model window and covers original records without omissions", async () => {
    const state = history();
    const f = fixture(state);
    const largeInput = { ...input(state), contextWindow: 12000 };
    f.control.open(state.id, new AbortController().signal);
    await f.control.beforeStep(largeInput, { signal: new AbortController().signal });
    const plan = planCompaction(state, buildPrompt(largeInput), f.config)!;
    const requests = f.complete.mock.calls.map(([p]) => p);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((p) => estimateTokens(p.prompt) <= 12000 - plan.summaryMaxTokens - 1024)).toBe(true);
    const sentSource = requests.map((p) => p.chat!.user.split(/New conversation records \(part starting at character \d+\):\n/)[1]).join("");
    const original = state.turns.slice(plan.from, plan.through).map((turn, i) => `Record ${plan.from + i}: ${JSON.stringify(turn)}`).join("\n");
    expect(sentSource).toBe(original);
    expect(f.persist).toHaveBeenCalledTimes(1);
    const progress = f.events.filter((e) => e.type === "compaction_progress");
    expect(progress[0]).toMatchObject({ chunk: 1, chunks: requests.length, completedChunks: 0, sourceTokens: estimateTokens(original) });
    expect(progress.at(-1)).toMatchObject({ completedChunks: requests.length });
    expect(progress.map((p) => p.completedChunks)).toEqual(requests.flatMap((_, i) => [i, i + 1]));
    f.control.close(state.id);
  });
  it("gives multiple progressing chunks more than a single-call timeout", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.config.timeoutMs = 1000;
    f.complete.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(completion()), 600)));
    const started = Date.now();
    const pending = f.compactSession("chat");
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ status: "compacted" });
    expect(Date.now() - started).toBeGreaterThan(f.config.timeoutMs);
    expect(f.persist).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses one call when the source fits the model window, without an artificial per-request cap", async () => {
    const state = history(70);
    const f = fixture(state);
    f.control.open(state.id, new AbortController().signal);
    const next = await f.control.beforeStep({ ...input(state), contextWindow: 262144 }, { signal: new AbortController().signal });
    expect(next?.compaction).toBeDefined();
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.events.filter((e) => e.type === "compaction_progress")).toEqual([
      expect.objectContaining({ chunk: 1, chunks: 1, completedChunks: 0 }),
      expect.objectContaining({ chunk: 1, chunks: 1, completedChunks: 1 }),
    ]);
    f.control.close(state.id);
  });
  it("anchors every merge to verbatim original, current and latest user requests within the input limit", async () => {
    let state = recordTurn(history(8), assistantReplyTurn("Earlier task remains unfinished; no changes or tests yet."));
    state = recordTurn(state, userTurn("CURRENT: finish the button first, never publish it."));
    for (const turn of history(20).turns.slice(1)) state = recordTurn(state, turn);
    state = recordTurn(state, steeredUserTurn("LATEST: keep keyboard shortcuts; do not repeat completed reads."));
    const f = fixture(state);
    expect((await f.compactSession(state.id)).status).toBe("compacted");
    expect(f.complete.mock.calls.length).toBeGreaterThan(1);
    for (const [request] of f.complete.mock.calls) {
      expect(request.chat!.user).toContain("ORIGINAL: preserve the green button and do not deploy");
      expect(request.chat!.user).toContain("CURRENT: finish the button first, never publish it.");
      expect(request.chat!.user).toContain("LATEST: keep keyboard shortcuts; do not repeat completed reads.");
      expect(request.chat!.system).toContain("not establish new goals");
      expect(estimateTokens(request.prompt)).toBeLessThanOrEqual(12000 - f.config.summaryMaxTokens - 1024);
    }
  });
  it("retains old state when request anchors leave no room instead of truncating them", async () => {
    let state = recordTurn(createEmptySessionState({ id: "chat", workingDir: dir }), userTurn("original ".repeat(5000)));
    state = recordTurn(state, assistantReplyTurn("Earlier task closed."));
    for (const turn of history(22).turns) state = recordTurn(state, turn);
    const f = fixture(state);
    expect(await f.compactSession(state.id)).toMatchObject({ status: "failed", message: expect.stringContaining("too small") });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.stored()).toBe(state);
  });
  it("enforces the total deadline even while individual chunks make progress", async () => {
    vi.useFakeTimers();
    const f = fixture(history(40)); f.config.timeoutMs = 1000; f.config.maxTotalTimeoutMs = 1500;
    const signals: AbortSignal[] = [];
    f.complete.mockImplementation((p) => {
      signals.push(p.signal!);
      return new Promise((resolve) => setTimeout(() => resolve(completion()), 600));
    });
    const pending = f.compactSession("chat");
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toMatchObject({ status: "failed", message: expect.stringContaining("total time limit (1500 ms)") });
    expect(f.persist).not.toHaveBeenCalled();
    expect(signals.at(-1)?.aborted).toBe(true);
    expect(f.events.at(-1)).toMatchObject({ calls: 2 });
    await vi.runAllTimersAsync();
    expect(f.persist).not.toHaveBeenCalled();
  });
  it("rolls back intermediate summaries if a later part stalls or is cancelled", async () => {
    for (const cancel of [false, true]) {
      vi.useFakeTimers();
      const f = fixture(); f.config.timeoutMs = 1000;
      const abort = new AbortController();
      let secondSignal: AbortSignal | undefined;
      f.complete.mockImplementationOnce(async () => completion());
      f.complete.mockImplementation((p) => {
        secondSignal = p.signal;
        if (cancel) abort.abort();
        return new Promise(() => {});
      });
      const pending = f.compactSession("chat", { signal: abort.signal });
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject(cancel ? { status: "cancelled" } : { status: "failed", message: expect.stringContaining("part 2/") });
      expect(secondSignal?.aborted).toBe(true);
      expect(f.persist).not.toHaveBeenCalled();
      expect(f.stored().compaction).toBeUndefined();
      expect(f.events.at(-1)).toMatchObject({ calls: 1 });
    }
  });
  it("preserves oversized records and Unicode across chunk boundaries", () => {
    const source = "record: " + "данные 🟢\n".repeat(2000) + "FINAL_MARKER";
    const chunks = planCompactionChunks(source, 300);
    const text = chunks.map(({ start, end }) => source.slice(start, end));
    expect(text.join("")).toBe(source);
    expect(text.every((s) => estimateTokens(s) <= 300 && !/[\ud800-\udbff]$/.test(s))).toBe(true);
  });
  it("identifies the file owning a continued result, including grouped calls and checkpoint offsets", () => {
    const turns = [userTurn("Fix target.ts; it has not been read."),
      assistantToolCallTurn({ tool: "os.fs.read", args: { path: "/first.ts" } }),
      assistantToolCallTurn({ tool: "os.fs.read", args: { path: "/second.ts" } }),
      toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "first contents ".repeat(1000) }),
      toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "second contents ".repeat(1000) }),
    ];
    const source = prepareCompactionSource(turns, 3, turns.length);
    expect(source.contextAt(100)).toContain('"toolCallRecord":1');
    expect(source.contextAt(100)).toContain('"path":"/first.ts"');
    const second = source.text.indexOf("second contents") + 100;
    expect(source.contextAt(second)).toContain('"toolCallRecord":2');
    expect(source.contextAt(second)).toContain('"path":"/second.ts"');
    expect(source.contextAt(second)).not.toContain("target.ts");
    expect(source.text).toBe(turns.slice(3).map((turn, i) => `Record ${3 + i}: ${JSON.stringify(turn)}`).join("\n"));
    expect(source.maxContextTokens).toBeGreaterThan(0);
  });
});

describe("compaction control inbox", () => {
  it("allows another request immediately after the previous result resolves", async () => {
    const f = fixture();
    expect((await f.compactSession("chat")).status).toBe("compacted");
    expect((await f.compactSession("chat")).status).not.toBe("busy");
    expect((await f.compactSession("chat")).status).not.toBe("busy");
  });
  it("waits for the next boundary, rejects duplicates and does not enqueue inside the occupied lock", async () => {
    const state = history(); const f = fixture(state); const abort = new AbortController();
    f.control.open(state.id, abort.signal);
    const requested = f.compactSession(state.id);
    expect(f.complete).not.toHaveBeenCalled();
    expect(await f.compactSession(state.id)).toMatchObject({ status: "busy" });
    await f.control.beforeStep(input(state), { signal: abort.signal });
    expect(await requested).toMatchObject({ status: "compacted" });
    f.control.close(state.id);
  });
  it("transfers an unconsumed request after turn unlock and reloads the latest saved state", async () => {
    const f = fixture(); let pending!: ReturnType<typeof f.compactSession>;
    await f.turnController.enqueue({ sessionId: "chat", origin: "tui", run: async () => {
      f.control.open("chat", new AbortController().signal);
      pending = f.compactSession("chat");
      f.persist(recordTurn(f.stored(), steeredUserTurn("arrived at turn end")));
      f.control.close("chat");
      expect(f.complete).not.toHaveBeenCalled();
    } });
    expect(await pending).toMatchObject({ status: "compacted" });
    expect(f.stored().turns.at(-1)).toMatchObject({ text: "arrived at turn end" });
  });
  it("request cancellation does not cancel the turn; session cancellation and shutdown cancel pending requests", async () => {
    const f = fixture(); const turn = new AbortController(); const request = new AbortController();
    f.control.open("chat", turn.signal);
    const pending = f.compactSession("chat", { signal: request.signal });
    request.abort();
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(turn.signal.aborted).toBe(false);
    const second = f.compactSession("chat"); turn.abort();
    expect(await second).toMatchObject({ status: "cancelled" });
    f.control.close("chat");
    const third = f.compactSession("chat"); f.shutdown();
    expect(await third).toMatchObject({ status: "cancelled" });
    expect(f.persist).not.toHaveBeenCalled();
  });
});
