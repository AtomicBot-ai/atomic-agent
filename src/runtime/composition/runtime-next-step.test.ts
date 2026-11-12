import { describe, expect, it, vi } from "vitest";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import { createEmptySessionState, type SessionState } from "../../session/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import {
  createNextStepSuggester,
  nextStepSuggestionsEnabled,
  type NextStepSuggesterDeps,
} from "./runtime-next-step.js";

function cfg(nextStepSuggestions?: unknown): AtomicAgentConfig {
  return {
    agent: {},
    tui: nextStepSuggestions === undefined ? {} : { nextStepSuggestions },
    localModels: { useServerTemplate: "auto" },
  } as unknown as AtomicAgentConfig;
}

function completion(content: string): CompletionResult {
  return { content, reasoningContent: "", stop: true, truncated: false, timing: { promptMs: 1, predictedMs: 1, promptTokens: 1, predictedTokens: 1 }, cacheHitTokens: 0, slotId: -1, modelId: null };
}

function answered(id = "s-1", turnCount = 1): SessionState {
  const base = createEmptySessionState({ id, workingDir: "/w" });
  return {
    ...base,
    turnCount,
    turns: [
      { kind: "user", text: "write a parser for the csv export", at: 1 },
      { kind: "assistant_reply", text: "Done: parser.ts reads the export.", at: 2 },
    ],
  };
}

async function flush() { for (let i = 0; i < 16; i++) await Promise.resolve(); }

function rig(overrides: Partial<NextStepSuggesterDeps> = {}) {
  const rows = new Map<string, SessionState>();
  const events: Array<[string, AgentLoopEvent]> = [];
  const llmComplete = vi.fn(async () => completion("Add tests for the parser"));
  const deps: NextStepSuggesterDeps = {
    getConfig: () => cfg(true),
    sessionStore: { save: (s) => { rows.set(s.id, s); }, load: (id) => rows.get(id) ?? null },
    llmComplete,
    slotManager: { sideCallSlotId: () => 3 },
    resolveTransport: () => "grammar",
    pending: new Set(),
    isShutdown: () => false,
    emitEvent: (id, event) => { events.push([id, event]); },
    logger: new StructuredLogger({ level: "debug", sinks: [] }),
    ...overrides,
  };
  return { deps, rows, events, llmComplete, suggester: createNextStepSuggester(deps) };
}

describe("nextStepSuggestionsEnabled", () => {
  it("is on only when tui.nextStepSuggestions is true", () => {
    expect(nextStepSuggestionsEnabled(cfg())).toBe(false);
    expect(nextStepSuggestionsEnabled(cfg(false))).toBe(false);
    expect(nextStepSuggestionsEnabled(cfg("true"))).toBe(false);
    expect(nextStepSuggestionsEnabled(cfg(true))).toBe(true);
  });
});

describe("createNextStepSuggester", () => {
  it("stores the suggestion for the turn and emits it to the session", async () => {
    const { suggester, rows, events, deps } = rig();
    const state = answered();
    rows.set(state.id, state);
    suggester.maybeSuggest(state, "tui");
    expect(deps.pending.size).toBe(1);
    await flush();
    expect(rows.get(state.id)?.metadata?.nextStep).toMatchObject({
      text: "Add tests for the parser",
      afterTurn: 1,
    });
    expect(events).toEqual([[state.id, { type: "next_step_suggestion", text: "Add tests for the parser" }]]);
    expect(deps.pending.size).toBe(0);
  });

  it("makes no call when off, for unwatched origins, or after a stopped turn", async () => {
    const off = rig({ getConfig: () => cfg() });
    off.suggester.maybeSuggest(answered(), "tui");
    const explicitOff = rig({ getConfig: () => cfg(false) });
    explicitOff.suggester.maybeSuggest(answered(), "http");
    const on = rig();
    on.suggester.maybeSuggest(answered(), "scheduler");
    on.suggester.maybeSuggest(answered(), "fusion");
    const stopped = answered();
    stopped.turns = [stopped.turns[0]!, { kind: "assistant_reply", text: "(stopped)", stopped: true, at: 2 }];
    on.suggester.maybeSuggest(stopped, "tui");
    await flush();
    expect(off.llmComplete).not.toHaveBeenCalled();
    expect(explicitOff.llmComplete).not.toHaveBeenCalled();
    expect(on.llmComplete).not.toHaveBeenCalled();
  });

  it("drops a suggestion a newer turn made stale, and never writes during shutdown", async () => {
    const stale = rig();
    const state = answered();
    stale.rows.set(state.id, { ...state, turnCount: 2 });
    stale.suggester.maybeSuggest(state, "tui");
    await flush();
    expect(stale.rows.get(state.id)?.metadata?.nextStep).toBeUndefined();
    expect(stale.events).toEqual([]);

    let closing = false;
    const gated = rig({
      isShutdown: () => closing,
      llmComplete: vi.fn(async () => { closing = true; return completion("Ship it"); }),
    });
    gated.rows.set(state.id, state);
    gated.suggester.maybeSuggest(state, "tui");
    await flush();
    expect(gated.rows.get(state.id)?.metadata?.nextStep).toBeUndefined();
    expect(gated.deps.pending.size).toBe(0);
  });

  it("swallows a failing call", async () => {
    const failing = rig({ llmComplete: vi.fn(async () => { throw new Error("refused"); }) });
    const state = answered();
    failing.rows.set(state.id, state);
    expect(() => failing.suggester.maybeSuggest(state, "tui")).not.toThrow();
    await flush();
    expect(failing.rows.get(state.id)?.metadata?.nextStep).toBeUndefined();
    expect(failing.deps.pending.size).toBe(0);
  });
});
