import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../config/index.js";
import { createCompactionDefaults, type CompactionConfig, type CompactionMode } from "../config/agent/compaction-config.js";
import { createEmptySessionState, recordTurn, type SessionState } from "../session/session-state.js";
import { assistantToolCallTurn, toolResultTurn, userTurn } from "../session/conversation-turn.js";
import { normalizeSessionState } from "../session/normalize-session-state.js";
import { validSessionCompaction } from "../session/session-compaction.js";
import { buildPrompt } from "../prompt/build-prompt.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import { estimateTokens } from "../prompt/token-budget.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import type { CompletionResult } from "../llm/provider/completion-types.js";
import type { LlmStreamParams } from "../agent/step/step-contract.js";
import type { CompactionEvent } from "../agent/compaction-control.js";
import { createContextCompaction } from "./context-compaction.js";
import type { CompactionRouteFacts } from "./compaction-mode.js";
import { TurnController } from "./turn-controller.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "context-compaction-extractive-"));
  vi.stubEnv("ATOMIC_AGENT_STATE_DIR", dir);
  resetConfigCache();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); resetConfigCache(); rmSync(dir, { recursive: true, force: true }); });

const SUMMARY = "Goal: finish the task. Constraints: keep the original requirements. Completed: the recorded reads succeeded. Next: continue.";
function completion(content = SUMMARY): CompletionResult {
  return { content, reasoningContent: "", stop: true, truncated: false, timing: { promptTokens: 100, predictedTokens: 30, promptMs: 1, predictedMs: 1 }, cacheHitTokens: 0, slotId: -1, modelId: "test-model" };
}
function history(steps = 22, from?: SessionState) {
  let state = from ?? recordTurn(createEmptySessionState({ id: "chat", workingDir: dir }), userTurn("ORIGINAL: preserve the green button and do not deploy"));
  for (let i = 0; i < steps; i++) {
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
function fixture(mode: CompactionMode, routeFacts: CompactionRouteFacts = {}, state = history(), promptInput = input) {
  let stored = state;
  const config: CompactionConfig = { ...createCompactionDefaults(), mode, summaryMaxTokens: 250 };
  const events: CompactionEvent[] = [];
  const complete = vi.fn(async (_params: LlmStreamParams) => completion());
  const persist = vi.fn((next: SessionState) => { stored = next; });
  const route = vi.fn((_id: string, providerId?: string) => ({ providerId: providerId ?? "current", transport: "grammar" as const, serverTemplate: true, ...routeFacts }));
  const service = createContextCompaction({
    config: () => config, sessionStore: { load: (id) => id === state.id ? stored : null }, turnController: new TurnController(),
    complete, route, persist, emit: (event) => events.push(event), sideCallSlotId: () => 3, promptInput,
  });
  return { ...service, complete, persist, events, config, stored: () => stored };
}

describe("extractive compaction", () => {
  it("compacts without a model call, within the summary budget, and persists the kind", async () => {
    const f = fixture("extractive");
    const started = performance.now();
    expect(await f.compactSession("chat")).toMatchObject({ status: "compacted" });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(f.complete).not.toHaveBeenCalled();
    const saved = f.stored().compaction!;
    expect(saved).toMatchObject({ kind: "extractive", model: null, calls: 0 });
    expect(estimateTokens(saved.summary)).toBeLessThanOrEqual(250);
    expect(saved.summary).toContain("ORIGINAL: preserve the green button and do not deploy");
    expect(saved.summary).toMatch(/read \/file-\d+ → ok/);
    expect(saved.summary).not.toContain("important details");
    const restored = normalizeSessionState(JSON.parse(JSON.stringify(f.stored())));
    expect(validSessionCompaction(restored)).toMatchObject({ kind: "extractive" });
    expect(buildPrompt(input(restored)).text).toContain(saved.summary);
    expect(f.events.map((e) => e.type)).toEqual(["compaction_started", "compaction_completed"]);
  });

  it("works on a cloud route and keeps its loaded instructions", async () => {
    const cloudInput = (session: SessionState): BuildPromptInput => ({ ...input(session),
      modelMode: { mode: "cloud", source: "provider", providerId: "remote", modelId: "large" },
      profileWindowApplies: false, completionMaxTokens: 1000, contextWindow: 16000 });
    let state = history(0);
    const body = "Complete rule\n".repeat(400) + "FINAL RULE";
    state.loadedSkills = [{ name: "guide", version: "1", body, loadedAt: 1 }];
    state.cloudContext = buildPrompt(cloudInput(state)).cloudContext;
    state = history(22, state);
    const f = fixture("extractive", {}, state, cloudInput);
    expect(await f.compactSession(state.id)).toMatchObject({ status: "compacted" });
    expect(f.complete).not.toHaveBeenCalled();
    const prompt = buildPrompt(cloudInput(f.stored()));
    expect(prompt.text).toContain(body);
    expect(prompt.text).toContain(f.stored().compaction!.summary);
  });
});

describe("auto compaction mode", () => {
  it("extracts on a local route without prefix reuse and asks the model elsewhere", async () => {
    const slow = fixture("auto", { local: true, prefixReuse: "none" });
    expect(await slow.compactSession("chat")).toMatchObject({ status: "compacted" });
    expect(slow.complete).not.toHaveBeenCalled();
    expect(slow.stored().compaction).toMatchObject({ kind: "extractive" });
    for (const facts of [{}, { local: true, prefixReuse: "partial" as const }]) {
      const f = fixture("auto", facts);
      expect(await f.compactSession("chat")).toMatchObject({ status: "compacted" });
      expect(f.complete).toHaveBeenCalled();
      expect(f.stored().compaction).toMatchObject({ model: "test-model" });
      expect(f.stored().compaction).not.toHaveProperty("kind");
    }
  });

  it("falls back to an extractive checkpoint when the model summary fails; model mode does not", async () => {
    const auto = fixture("auto");
    auto.complete.mockRejectedValue(new Error("provider down"));
    expect(await auto.compactSession("chat")).toMatchObject({ status: "compacted", message: expect.stringContaining("provider down") });
    expect(auto.stored().compaction).toMatchObject({ kind: "extractive", model: null });
    const model = fixture("model");
    model.complete.mockRejectedValue(new Error("provider down"));
    expect(await model.compactSession("chat")).toMatchObject({ status: "failed", message: "provider down" });
    expect(model.persist).not.toHaveBeenCalled();
  });

  it("after a model summary times out, extracts directly on that route", async () => {
    const f = fixture("auto"); f.config.timeoutMs = 10;
    f.complete.mockImplementation(() => new Promise(() => {}));
    expect(await f.compactSession("chat")).toMatchObject({ status: "compacted", message: expect.stringContaining("timed out") });
    expect(f.stored().compaction).toMatchObject({ kind: "extractive" });
    const calls = f.complete.mock.calls.length;
    f.persist(history(22, f.stored()));
    const started = performance.now();
    expect(await f.compactSession("chat")).toMatchObject({ status: "compacted" });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(f.complete).toHaveBeenCalledTimes(calls);
  });
});
