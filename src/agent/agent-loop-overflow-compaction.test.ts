import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "./agent-loop.js";
import type { AgentLoopEvent } from "./agent-loop.js";
import type { ContextCompactionControl, CompactionStepOptions } from "./compaction-control.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { LlamaServerError } from "../llm/llama-server-client.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { SessionState } from "../session/session-state.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import type { CapabilitiesSummary, ToolDescriptor } from "../prompt/stable-prefix.js";

/**
 * ATO-1028: a local server refusing a step as too large for its context
 * window (`exceed_context_size_error`) compacts the conversation once and
 * retries the step; a second refusal ends the turn with plain words, and
 * nothing loops.
 */

const TOOLS: ToolDescriptor[] = [
  { name: "finish", summary: "Finish the session with a summary.", argsSchema: '{"summary": string}' },
];
const CAPS: CapabilitiesSummary = {
  platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/work",
  hasClipboard: true, hasWmctrl: false, hasNotifications: true,
};

function reply(text: string): CompletionResult {
  return {
    content: JSON.stringify({ tool: "reply", args: { text } }),
    reasoningContent: "", stop: true, truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0, slotId: 0, modelId: "mock",
  };
}

/** llama.cpp's current overflow answer: no numbers in the sentence, both in the body. */
function overflow(counts: { contextWindow?: number; promptTokens?: number } = {}): LlamaServerError {
  return new LlamaServerError(
    "llama-server returned http 400: the request exceeds the available context size, try increasing it",
    400, "http://127.0.0.1:8080/completion", false, undefined,
    { body: { type: "exceed_context_size_error", ...counts } },
  );
}

/** A compaction control whose overflow request always produces a new checkpoint. */
function compactionStub(): {
  control: ContextCompactionControl;
  overflowCalls: Array<{ input: BuildPromptInput; options: CompactionStepOptions }>;
} {
  const overflowCalls: Array<{ input: BuildPromptInput; options: CompactionStepOptions }> = [];
  const beforeStep = vi.fn((input: BuildPromptInput, options: CompactionStepOptions): Promise<SessionState> | undefined => {
    if (options.requested !== "overflow") return undefined;
    overflowCalls.push({ input, options });
    const next: SessionState = {
      ...input.session,
      compaction: {
        version: 1, summary: "older work, summarized", coveredThrough: 1, boundaryHash: "x",
        createdAt: Date.now(), reason: "overflow", model: null, kind: "extractive",
        tokensBefore: 9_000, tokensAfter: 1_000,
      },
    };
    return Promise.resolve(next);
  });
  return { control: { open() {}, close() {}, beforeStep }, overflowCalls };
}

describe("AgentLoop overflow compaction (ATO-1028)", () => {
  let workingDir: string;
  beforeEach(() => { workingDir = mkdtempSync(join(tmpdir(), "atomic-agent-overflow-")); });
  afterEach(() => { rmSync(workingDir, { recursive: true, force: true }); });

  function loopWith(llmComplete: () => Promise<CompletionResult>, extra: {
    compaction: ContextCompactionControl;
    events: AgentLoopEvent[];
    observed?: number[];
    profileWindow?: number;
  }): AgentLoop {
    return new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      profile: { ...PLAIN_INSTRUCT_PROFILE, contextWindow: extra.profileWindow ?? 32_768 },
      llmComplete,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
      compaction: extra.compaction,
      onContextWindowObserved: (window) => extra.observed?.push(window),
      onEvent: (event) => extra.events.push(event),
    });
  }

  function session(id: string): SessionState {
    return createEmptySessionState({ id, workingDir });
  }

  it("compacts and retries the step once when the first send overflows", async () => {
    const { control, overflowCalls } = compactionStub();
    const events: AgentLoopEvent[] = [];
    const observed: number[] = [];
    let calls = 0;
    const loop = loopWith(async () => {
      calls += 1;
      if (calls === 1) throw overflow({ contextWindow: 8_192 });
      return reply("fits now");
    }, { compaction: control, events, observed });

    const result = await loop.runTurn(session("s-overflow-once"), {
      userMessage: "keep going", maxSteps: 5, taskMaxSteps: 5, signal: new AbortController().signal,
    });

    expect(result.reason).toBe("reply");
    expect(calls).toBe(2);
    expect(overflowCalls).toHaveLength(1);
    // Planned against the window the server named, not the 32k probe.
    expect(overflowCalls[0]!.input.contextWindow).toBe(8_192);
    expect(overflowCalls[0]!.input.profileWindowApplies).toBe(false);
    expect(observed).toEqual([8_192]);
    expect(events).toContainEqual(expect.objectContaining({ type: "prompt_repacked", contextWindow: 8_192, source: "provider", stepIndex: 0 }));
    expect(events.some((event) => event.type === "loop_failed")).toBe(false);
  });

  it("ends the turn with a plain message on a second overflow, without looping", async () => {
    const { control, overflowCalls } = compactionStub();
    const events: AgentLoopEvent[] = [];
    let calls = 0;
    const loop = loopWith(async () => {
      calls += 1;
      throw overflow({ contextWindow: 8_192, promptTokens: 12_000 });
    }, { compaction: control, events });

    const result = await loop.runTurn(session("s-overflow-twice"), {
      userMessage: "keep going", maxSteps: 5, taskMaxSteps: 5, signal: new AbortController().signal,
    });

    expect(result.reason).toBe("failed");
    expect(calls).toBe(2);
    expect(overflowCalls).toHaveLength(1);
    const failed = events.find((event): event is Extract<AgentLoopEvent, { type: "loop_failed" }> => event.type === "loop_failed");
    expect(failed?.error.message).toContain("no longer fits this model's context window (8,192 tokens)");
    expect(failed?.error.message).toContain("even after older history was compacted");
    expect(failed?.error.message).not.toContain("llama-server returned http 400");
    // The server's own sentence stays on the cause chain for logs.
    expect(String((failed?.error as { cause?: Error }).cause?.message)).toContain("exceeds the available context size");
  });

  it("says so plainly when compaction cannot free any room", async () => {
    const events: AgentLoopEvent[] = [];
    const beforeStep = vi.fn(() => undefined);
    let calls = 0;
    const loop = loopWith(async () => {
      calls += 1;
      throw overflow();
    }, { compaction: { open() {}, close() {}, beforeStep }, events });

    const result = await loop.runTurn(session("s-overflow-noop"), {
      userMessage: "keep going", maxSteps: 5, taskMaxSteps: 5, signal: new AbortController().signal,
    });

    expect(result.reason).toBe("failed");
    expect(calls).toBe(1);
    const failed = events.find((event): event is Extract<AgentLoopEvent, { type: "loop_failed" }> => event.type === "loop_failed");
    expect(failed?.error.message).toContain("could not be compacted to make room");
    expect(failed?.error.message).toContain("larger context size");
  });

  it("budgets against the server's /props n_ctx when it is smaller than the configured window", async () => {
    const events: AgentLoopEvent[] = [];
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(), slotManager: new SlotManager(2), grammar: 'root ::= "ok"',
      // What /props reported vs what the configuration / catalogue assumes.
      profile: { ...PLAIN_INSTRUCT_PROFILE, contextWindow: 8_192 },
      contextWindow: () => 131_072,
      llmComplete: async () => reply("done"),
      toolDescriptors: TOOLS, capabilities: CAPS, skillCatalog: [],
      onEvent: (event) => events.push(event),
    });
    await loop.runTurn(session("s-props-window"), {
      userMessage: "hi", maxSteps: 2, taskMaxSteps: 2, signal: new AbortController().signal,
    });
    const built = events.flatMap((event) =>
      event.type === "llm_event" && event.event.type === "prompt_built" ? [event.event.prompt] : []);
    expect(built.length).toBeGreaterThan(0);
    expect(built[0]!.contextWindow).toBe(8_192);
    expect(built[0]!.conversationCapEffective).toBeLessThan(8_192);
  });

  it("keeps the server's sentence when no compaction is wired (legacy wiring)", async () => {
    const events: AgentLoopEvent[] = [];
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(), slotManager: new SlotManager(2), grammar: 'root ::= "ok"',
      llmComplete: async () => { throw overflow({ contextWindow: 8_192 }); },
      toolDescriptors: TOOLS, capabilities: CAPS, skillCatalog: [],
      onEvent: (event) => events.push(event),
    });
    const result = await loop.runTurn(session("s-overflow-legacy"), {
      userMessage: "keep going", maxSteps: 5, taskMaxSteps: 5, signal: new AbortController().signal,
    });
    expect(result.reason).toBe("failed");
    const failed = events.find((event): event is Extract<AgentLoopEvent, { type: "loop_failed" }> => event.type === "loop_failed");
    expect(failed?.error.message).toContain("exceeds the available context size");
  });
});
