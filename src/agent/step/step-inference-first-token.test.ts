import { describe, expect, it } from "vitest";
import type { CompletionResult, StreamChunk } from "../../llm/provider/completion-types.js";
import { PLAIN_INSTRUCT_PROFILE, QWEN_THINK_PROFILE } from "../../llm/model-profile.js";
import { SlotManager } from "../../llm/slot-manager.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { StepContext, StepDependencies, LlmStreamParams } from "./step-contract.js";
import type { StepEvent } from "../step-events.js";
import { consumeStream, prepareStepInference, runInitialCompletion } from "./step-inference.js";
import { claimTurnProgress, turnProgressWanted } from "./turn-progress-opt-in.js";

// ATO-1027: the wait before a step's first output, as step events a host
// can show — `prompt_progress` while the prompt is read, `first_token`
// when anything comes back.

function completion(overrides: Partial<CompletionResult> = {}): CompletionResult {
  return {
    content: '[{"tool":"reply","args":{"text":"ok"}}]',
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 1, predictedTokens: 1 },
    cacheHitTokens: 0,
    slotId: -1,
    modelId: "fixture",
    ...overrides,
  };
}

function fixture(): { ctx: StepContext; deps: StepDependencies } {
  return {
    ctx: {
      session: createEmptySessionState({ id: "first-token-fixture", workingDir: "/fixture" }),
      toolDescriptors: [],
      skillCatalog: [],
      capabilities: {
        platform: "darwin", arch: "arm64", browserChannel: "chrome",
        workingDir: "/fixture", hasClipboard: false, hasWmctrl: false,
        hasNotifications: false,
      },
      stepIndex: 3,
      signal: new AbortController().signal,
      maxTokens: 2048,
    },
    deps: {
      registry: new ToolRegistry(),
      slotManager: new SlotManager(1),
      profile: PLAIN_INSTRUCT_PROFILE,
      grammar: 'root ::= "fixture"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async () => completion(),
    },
  };
}

describe("first_token", () => {
  it("is told once, after the first chunk's own deltas", async () => {
    const events: StepEvent[] = [];
    async function* stream(): AsyncGenerator<StreamChunk, CompletionResult, void> {
      yield { delta: "", reasoningDelta: "", done: false };
      yield { delta: "", reasoningDelta: "plan", done: false };
      yield { delta: "", reasoningDelta: " more", done: false };
      return completion();
    }
    await consumeStream(stream(), 4, QWEN_THINK_PROFILE, "native_tools", false, (e) => events.push(e), true);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "first_token")).toHaveLength(1);
    expect(types.indexOf("reasoning_delta")).toBeLessThan(types.indexOf("first_token"));
    expect(events).toContainEqual({ type: "first_token", stepIndex: 4 });
  });

  it("is not told for a stream that produced nothing", async () => {
    const events: StepEvent[] = [];
    async function* stream(): AsyncGenerator<StreamChunk, CompletionResult, void> {
      yield { delta: "", reasoningDelta: "", done: true };
      return completion({ content: "" });
    }
    await consumeStream(stream(), 0, PLAIN_INSTRUCT_PROFILE, "grammar", false, (e) => events.push(e), true);
    expect(events.some((e) => e.type === "first_token")).toBe(false);
  });

  it("is not told unless the session asked", async () => {
    const events: StepEvent[] = [];
    async function* stream(): AsyncGenerator<StreamChunk, CompletionResult, void> {
      yield { delta: "", reasoningDelta: "plan", done: false };
      return completion();
    }
    await consumeStream(stream(), 0, QWEN_THINK_PROFILE, "native_tools", false, (e) => events.push(e));
    expect(events.some((e) => e.type === "first_token")).toBe(false);
    expect(events.some((e) => e.type === "reasoning_delta")).toBe(true);
  });
});

describe("prompt_progress", () => {
  it("hands the streamed request a listener that reports as step events", async () => {
    const { ctx, deps } = fixture();
    const events: StepEvent[] = [];
    deps.onEvent = (event) => events.push(event);
    let sent: LlmStreamParams | undefined;
    deps.llmCompleteStream = async function* (params) {
      sent = params;
      params.onPromptProgress?.({ processed: 512, total: 2048, cached: 0, elapsedMs: 900 });
      yield { delta: '[{"tool":"reply","args":{"text":"ok"}}]', reasoningDelta: "", done: true };
      return completion();
    };
    const prepared = prepareStepInference(ctx, deps);
    const release = claimTurnProgress(ctx.session.id);
    try {
      await runInitialCompletion({ ctx, deps, ...prepared });
    } finally {
      release();
    }
    expect(sent?.onPromptProgress).toBeTypeOf("function");
    expect(events).toContainEqual({
      type: "prompt_progress",
      stepIndex: 3,
      processed: 512,
      total: 2048,
      cached: 0,
      elapsedMs: 900,
    });
  });

  it("asks for nothing when the session's host did not ask (TUI, channels, workers)", async () => {
    const { ctx, deps } = fixture();
    const events: StepEvent[] = [];
    deps.onEvent = (event) => events.push(event);
    let sent: LlmStreamParams | undefined;
    deps.llmCompleteStream = async function* (params) {
      sent = params;
      yield { delta: '[{"tool":"reply","args":{"text":"ok"}}]', reasoningDelta: "", done: true };
      return completion();
    };
    const prepared = prepareStepInference(ctx, deps);
    await runInitialCompletion({ ctx, deps, ...prepared });
    expect(sent).toBeDefined();
    expect(sent).not.toHaveProperty("onPromptProgress");
    expect(events.some((e) => e.type === "first_token")).toBe(false);
  });

  it("asks for nothing when no one listens to step events", async () => {
    const { ctx, deps } = fixture();
    let sent: LlmStreamParams | undefined;
    deps.llmCompleteStream = async function* (params) {
      sent = params;
      return completion();
    };
    const prepared = prepareStepInference(ctx, deps);
    const release = claimTurnProgress(ctx.session.id);
    try {
      await runInitialCompletion({ ctx, deps, ...prepared });
    } finally {
      release();
    }
    expect(sent).toBeDefined();
    expect(sent).not.toHaveProperty("onPromptProgress");
  });
});

describe("claimTurnProgress", () => {
  it("holds per session until every claim is released", () => {
    const a = claimTurnProgress("s-a");
    const b = claimTurnProgress("s-a");
    expect(turnProgressWanted("s-a")).toBe(true);
    expect(turnProgressWanted("s-b")).toBe(false);
    a();
    a();
    expect(turnProgressWanted("s-a")).toBe(true);
    b();
    expect(turnProgressWanted("s-a")).toBe(false);
  });
});
