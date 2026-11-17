import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../config/index.js";
import { createCompactionDefaults, parseCompactionConfig, type CompactionConfig } from "../config/agent/compaction-config.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import type { CompletionResult } from "../llm/provider/completion-types.js";
import type { LlmStreamParams } from "../agent/step/step-contract.js";
import type { MemoryStoreInput } from "../memory/memory-store.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import { assistantToolCallTurn, toolResultTurn, userTurn } from "../session/conversation-turn.js";
import { createEmptySessionState, recordTurn, type SessionState } from "../session/session-state.js";
import { createContextCompaction } from "./context-compaction.js";
import { TurnController } from "./turn-controller.js";
import { localDay, MEMORY_FLUSH_MAX_LINES, MEMORY_FLUSH_TAG, parseObservations } from "./compaction-memory-flush.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-memory-flush-"));
  vi.stubEnv("ATOMIC_AGENT_STATE_DIR", dir);
  resetConfigCache();
});
afterEach(() => { vi.unstubAllEnvs(); resetConfigCache(); rmSync(dir, { recursive: true, force: true }); });

const FLUSH_MARKER = "Write dated observations for long-term memory";

function completion(content: string): CompletionResult {
  return { content, reasoningContent: "", stop: true, truncated: false,
    timing: { promptTokens: 100, predictedTokens: 30, promptMs: 1, predictedMs: 1 }, cacheHitTokens: 0, slotId: -1, modelId: "test-model",
    usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 } };
}

function history(steps = 22): SessionState {
  let state = recordTurn(createEmptySessionState({ id: "chat", workingDir: "/work" }), userTurn("ORIGINAL: preserve the green button and do not deploy"));
  for (let i = 0; i < steps; i++) {
    state = recordTurn(state, assistantToolCallTurn({ tool: "os.fs.read", args: { path: `/file-${i}` } }));
    state = recordTurn(state, toolResultTurn({ tool: "os.fs.read", status: "ok", summary: `result ${i}: ${"important details ".repeat(150)}` }));
  }
  return state;
}

function input(session: SessionState): BuildPromptInput {
  return { session, toolDescriptors: [], skillCatalog: [], profile: PLAIN_INSTRUCT_PROFILE,
    contextWindow: 12000, conversationMaxTokens: 4000, conversationMaxPairs: 200,
    capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/work", hasClipboard: false, hasWmctrl: false, hasNotifications: false } };
}

const isFlush = (params: LlmStreamParams) => (params.chat?.system ?? params.prompt).includes(FLUSH_MARKER);

function fixture(overrides: Partial<CompactionConfig>, flushReply: () => Promise<CompletionResult> = async () => completion("- 2001-01-01: Read the files.\nRead /file-3 for the button colour.")) {
  const state = history();
  let stored = state;
  const config: CompactionConfig = { ...createCompactionDefaults(), summaryMaxTokens: 250, ...overrides };
  const complete = vi.fn(async (params: LlmStreamParams) => isFlush(params)
    ? flushReply()
    : completion("Goal: finish the task. Constraints: keep the original requirements. Completed: the recorded reads succeeded. Next: continue the unfinished work."));
  const store = vi.fn((_note: MemoryStoreInput) => ({}));
  const log = vi.fn();
  const persist = vi.fn((next: SessionState) => { stored = next; });
  const service = createContextCompaction({
    config: () => config, sessionStore: { load: (id) => id === state.id ? stored : null }, turnController: new TurnController(),
    complete, persist, emit: () => {}, sideCallSlotId: () => 3, promptInput: input,
    route: (_id: string, providerId?: string) => ({ providerId: providerId ?? "current", transport: "grammar" as const, serverTemplate: true }),
    memoryNotes: { enabled: () => true, store, log },
  });
  return { ...service, state, complete, store, log, stored: () => stored };
}

describe("compaction memory flush config", () => {
  it("is off by default and parses a boolean", () => {
    expect(createCompactionDefaults().memoryFlush).toBe(false);
    expect(parseCompactionConfig(undefined, createCompactionDefaults()).memoryFlush).toBe(false);
    expect(parseCompactionConfig({}, createCompactionDefaults()).memoryFlush).toBe(false);
    expect(parseCompactionConfig({ memoryFlush: true }, createCompactionDefaults()).memoryFlush).toBe(true);
    expect(() => parseCompactionConfig({ memoryFlush: 3 }, createCompactionDefaults())).toThrow();
  });
});

describe("parseObservations", () => {
  it("keeps dated lines, dates undated ones, drops markers, NONE and duplicates", () => {
    const lines = parseObservations("- 2026-11-12: Chose plan B.\n* chose plan B\n2026-11-12 - Chose plan B.\nNONE\n1. Left the deploy for later.", "2026-11-13", "2026-11-13");
    expect(lines).toEqual(["2026-11-12: Chose plan B.", "2026-11-13: chose plan B", "2026-11-13: Left the deploy for later."]);
  });
  it("replaces impossible or future dates and bounds the count", () => {
    expect(parseObservations("2026-02-30: x\n2099-01-01: y", "2026-11-13", "2026-11-13")).toEqual(["2026-11-13: x", "2026-11-13: y"]);
    expect(parseObservations("NONE", "2026-11-13", "2026-11-13")).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => `2026-11-13: fact ${i}`).join("\n");
    expect(parseObservations(many, "2026-11-13", "2026-11-13")).toHaveLength(MEMORY_FLUSH_MAX_LINES);
  });
});

describe("compaction memory flush", () => {
  it("flag on: appends exactly one dated note before the checkpoint and leaves the chat unchanged", async () => {
    const f = fixture({ mode: "extractive", memoryFlush: true });
    const before = structuredClone(f.state.turns);
    expect(await f.compactSession(f.state.id)).toMatchObject({ status: "compacted" });
    // Extractive mode makes no summary call, so the only call is the flush.
    expect(f.complete).toHaveBeenCalledOnce();
    const call = f.complete.mock.calls[0]![0];
    expect(isFlush(call)).toBe(true);
    expect(call.sessionId).toBe("compaction:chat");
    expect(call.slotId).toBe(3);
    expect(call.disableThinking).toBe(true);
    expect(f.store).toHaveBeenCalledOnce();
    const note = f.store.mock.calls[0]![0];
    const today = localDay(Date.now());
    expect(note.tags).toEqual([MEMORY_FLUSH_TAG, `date-${today}`]);
    expect(note.sessionId).toBe("chat");
    expect(note.workingDir).toBe("/work");
    const lines = note.content.split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/^\d{4}-\d{2}-\d{2}: \S/);
    expect(lines[0]).toBe("2001-01-01: Read the files.");
    // Nothing reached the visible conversation: same records, only the checkpoint is new.
    expect(f.stored().turns).toEqual(before);
    expect(f.stored().compaction?.summary).not.toContain("Read /file-3 for the button colour.");
  });

  it("flag on with a model summary: the flush runs first, then the summary", async () => {
    const f = fixture({ mode: "model", memoryFlush: true });
    expect(await f.compactSession(f.state.id)).toMatchObject({ status: "compacted" });
    expect(isFlush(f.complete.mock.calls[0]![0])).toBe(true);
    expect(f.complete.mock.calls.slice(1).some((call) => isFlush(call[0]))).toBe(false);
    expect(f.store).toHaveBeenCalledOnce();
  });

  it("flag off: no flush call and no note", async () => {
    const extractive = fixture({ mode: "extractive" });
    expect(await extractive.compactSession(extractive.state.id)).toMatchObject({ status: "compacted" });
    expect(extractive.complete).not.toHaveBeenCalled();
    expect(extractive.store).not.toHaveBeenCalled();
    const model = fixture({ mode: "model", memoryFlush: false });
    expect(await model.compactSession(model.state.id)).toMatchObject({ status: "compacted" });
    expect(model.complete).toHaveBeenCalled();
    expect(model.complete.mock.calls.some((call) => isFlush(call[0]))).toBe(false);
    expect(model.store).not.toHaveBeenCalled();
  });

  it("a failed flush is logged and the compaction still completes", async () => {
    const f = fixture({ mode: "extractive", memoryFlush: true }, async () => { throw new Error("provider down"); });
    expect(await f.compactSession(f.state.id)).toMatchObject({ status: "compacted" });
    expect(f.store).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith("warn", expect.stringContaining("memory flush failed"), expect.objectContaining({ reason: "provider down" }));
  });

  it("a NONE reply stores nothing", async () => {
    const f = fixture({ mode: "extractive", memoryFlush: true }, async () => completion("NONE"));
    expect(await f.compactSession(f.state.id)).toMatchObject({ status: "compacted" });
    expect(f.complete).toHaveBeenCalledOnce();
    expect(f.store).not.toHaveBeenCalled();
  });
});
