import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type {
  CompletionResult,
  LlamaServerClient,
} from "../llm/llama-server-client.js";
import { ModelProfileManager } from "../llm/model-profile-manager.js";
import {
  GEMMA4_PROPS,
  QWEN3_PROPS,
} from "../llm/model-profile.fixtures.js";
import {
  GEMMA4_THINK_PROFILE,
  QWEN_THINK_PROFILE,
} from "../llm/model-profile.js";
import { buildGrammar } from "../llm/grammar/build-grammar.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";

function makeCompletion(
  content: string,
  modelId: string = "mock",
): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId,
  };
}

const TOOLS: ToolDescriptor[] = [
  {
    name: "finish",
    summary: "Finish the session with a summary.",
    argsSchema: '{"summary": string}',
  },
];

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

const SKILLS: SkillCatalogEntry[] = [];

describe("AgentLoop end-to-end with mock LLM", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-agent-loop-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it("emits prompt_captured and llm_raw_completion alongside canonical step events", async () => {
    const registry = buildDefaultToolRegistry();
    const stepEventTypes: string[] = [];
    const promptCaptured: Array<{
      stablePrefixHash: string;
      tail: string;
      tokens: { total: number; stablePrefix: number; tail: number };
      slotId: number;
      cacheReused: boolean;
    }> = [];
    const llmRawCompletions: Array<{ attempt: 1 | 2; stepIndex: number }> = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(
          JSON.stringify({ tool: "finish", args: { summary: "done" } }),
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type !== "llm_event") return;
        stepEventTypes.push(event.event.type);
        if (event.event.type === "prompt_captured") {
          promptCaptured.push({
            stablePrefixHash: event.event.stablePrefixHash,
            tail: event.event.tail,
            tokens: event.event.tokens,
            slotId: event.event.slotId,
            cacheReused: event.event.cacheReused,
          });
        }
        if (event.event.type === "llm_raw_completion") {
          llmRawCompletions.push({
            attempt: event.event.attempt,
            stepIndex: event.event.stepIndex,
          });
        }
      },
    });
    const session = createEmptySessionState({ id: "s-trace", workingDir });
    await loop.runTurn(session, {
      userMessage: "trace me",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(stepEventTypes).toContain("prompt_captured");
    expect(stepEventTypes).toContain("llm_raw_completion");
    expect(promptCaptured).toHaveLength(1);
    expect(promptCaptured[0]!.stablePrefixHash).toMatch(/^[0-9a-f]{64}$/);
    expect(promptCaptured[0]!.tokens.total).toBeGreaterThan(0);
    expect(llmRawCompletions).toEqual([{ attempt: 1, stepIndex: 0 }]);
  });

  it("finishes session immediately when the LLM emits a finish tool call", async () => {
    const registry = buildDefaultToolRegistry();
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(
          JSON.stringify({ tool: "finish", args: { summary: "done" } }),
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({ id: "s1", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "please wrap up",
      maxSteps: 5,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("finish");
    expect(result.session.status).toBe("completed");
    expect(result.session.latestResult?.tool).toBe("finish");
    expect(result.session.stepCount).toBe(1);
  });

  it("soft-fails invalid tool JSON after repair instead of killing the session", async () => {
    const registry = buildDefaultToolRegistry();
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => makeCompletion("not a json"),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({ id: "s-bad", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "whatever",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
    expect(result.session.status).toBe("pending");
    expect(result.session.lastError == null).toBe(true);
    const last = result.session.turns.at(-1);
    expect(last?.kind).toBe("assistant_reply");
  });

  it("recovers via a one-shot parser retry when the first completion is malformed", async () => {
    const registry = buildDefaultToolRegistry();
    const responses = [
      "{{garbage",
      JSON.stringify({ tool: "finish", args: { summary: "recovered" } }),
    ];
    let calls = 0;
    const stepEventTypes: string[] = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        const body = responses[calls] ?? responses[responses.length - 1] ?? "";
        calls += 1;
        return makeCompletion(body);
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "llm_event") stepEventTypes.push(event.event.type);
      },
    });
    const session = createEmptySessionState({ id: "s-retry", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "please wrap up",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("finish");
    expect(calls).toBe(2);
    expect(stepEventTypes.filter((t) => t === "parse_retry")).toHaveLength(1);
    expect(stepEventTypes).not.toContain("step_error");
  });

  it("runTurn appends user message and exits on reply", async () => {
    const registry = buildDefaultToolRegistry();
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "hello there" } }),
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({
      id: "chat-1",
      workingDir,
    });
    const result = await loop.runTurn(session, {
      userMessage: "hi",
      maxSteps: 5,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
    expect(result.session.status).toBe("pending");
    expect(result.session.turnCount).toBe(1);
    const turns = result.session.turns;
    expect(turns[0]).toMatchObject({ kind: "user", text: "hi" });
    expect(turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "hello there",
    });
  });

  it("runTurn synthesises an assistant reply when max steps is hit", async () => {
    const registry = buildDefaultToolRegistry();
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(
          JSON.stringify({
            tool: "browser.read_aria",
            args: {},
          }),
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({
      id: "chat-stuck",
      workingDir,
    });
    // browser.read_aria is dangerous → throws since approval gate blocks
    // it here. Easier path: use a never-finishing tool. We rely on the
    // mock grammar/parsing — supply a tool that always succeeds with a
    // non-terminal result by mocking a no-op via finish+swallow. The
    // simplest is to just cap maxSteps very low and let one finishing
    // step be replaced by a non-terminal one through a custom registry.
    // Here we register a dummy noop tool inline:
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        return {
          tool: "noop",
          status: "ok",
          summary: "noop",
          details: {},
          truncated: false,
        };
      },
    });
    const loopNoop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(JSON.stringify({ tool: "noop", args: {} })),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const result = await loopNoop.runTurn(session, {
      userMessage: "do stuff",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("max_steps");
    expect(result.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: expect.stringContaining("max_steps"),
    });
    expect(result.session.status).toBe("stalled");
    expect(result.session.lastError).toMatch(/max_steps_reached: 2 steps/);
  });

  it("injects a transient notice into the next prompt when a no-progress loop is detected", async () => {
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        return {
          tool: "noop",
          status: "ok",
          summary: "noop",
          details: {},
          truncated: false,
        };
      },
    });
    const prompts: string[] = [];
    const events: Array<{ type: string; tool?: string; count?: number }> = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async ({ prompt }) => {
        prompts.push(prompt);
        // Always emit the same tool with the same args → guaranteed loop.
        return makeCompletion(JSON.stringify({ tool: "noop", args: {} }));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "loop_detected") {
          events.push({
            type: event.type,
            tool: event.tool,
            count: event.count,
          });
        }
      },
    });
    const session = createEmptySessionState({
      id: "s-loop",
      workingDir,
    });
    await loop.runTurn(session, {
      userMessage: "stuck",
      maxSteps: 5,
      signal: new AbortController().signal,
    });
    // The phrase "### notice" appears in the system persona regardless,
    // so we detect the notice by its body text which is only present
    // when the detector fired.
    const NOTICE_MARK = /same arguments \d+ times/;
    expect(NOTICE_MARK.test(prompts[0]!)).toBe(false);
    expect(NOTICE_MARK.test(prompts[1]!)).toBe(false);
    expect(prompts.some((p) => NOTICE_MARK.test(p))).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.tool).toBe("noop");
    expect(events[0]?.count).toBeGreaterThanOrEqual(3);
  });

  it("ends the turn with a graceful reply (not loop_failed) when the breaker trips", async () => {
    const registry = buildDefaultToolRegistry();
    let runCount = 0;
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        runCount += 1;
        return {
          tool: "noop",
          status: "ok",
          summary: "noop",
          details: {},
          truncated: false,
        };
      },
    });
    const detectedEvents: Array<{
      count: number;
      level?: string;
    }> = [];
    const failedEvents: Array<{ category: string; message: string }> = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(JSON.stringify({ tool: "noop", args: {} })),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "loop_detected") {
          detectedEvents.push({ count: event.count, level: event.level });
        } else if (event.type === "loop_failed") {
          failedEvents.push({
            category: event.category,
            message: event.error.message,
          });
        }
      },
    });
    const session = createEmptySessionState({
      id: "s-loop-breaker",
      workingDir,
    });
    // Default thresholds: warn=3, critical=5, breaker=3. The streak hits
    // critical at step 5 (vetoes start), and after 3 consecutive vetoes
    // the breaker trips and forces a graceful reply.
    const result = await loop.runTurn(session, {
      userMessage: "stuck",
      maxSteps: 12,
      signal: new AbortController().signal,
    });
    // Graceful termination: reply, NOT failed.
    expect(result.reason).toBe("reply");
    expect(result.session.status).toBe("pending");
    expect(failedEvents.length).toBe(0);
    // The last turn is the forced synthetic reply.
    expect(result.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: expect.stringMatching(/no-progress loop/),
    });
    // A breaker-level loop_detected event was surfaced.
    expect(detectedEvents.some((e) => e.level === "breaker")).toBe(true);
    // Critical vetoes prevented the tool from running every step — the
    // veto plateau means `noop` ran far fewer times than the step budget.
    expect(runCount).toBeLessThan(12);
  });

  it("refreshes memory context between non-terminal tool steps", async () => {
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        return {
          tool: "noop",
          status: "ok",
          summary: "read src/cart.ts",
          details: {},
          truncated: false,
        };
      },
    });
    const providerInputs: Array<{
      userMessage: string | null;
      toolResultSummaries?: readonly string[];
    }> = [];
    let calls = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        calls += 1;
        return makeCompletion(
          calls === 1
            ? JSON.stringify({ tool: "noop", args: {} })
            : JSON.stringify({ tool: "reply", args: { text: "done" } }),
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      memoryContextProvider: {
        buildMemoryContext(input) {
          providerInputs.push({
            userMessage: input.userMessage,
            toolResultSummaries: input.toolResultSummaries,
          });
          return { recalled: [], index: [] };
        },
      },
    });
    const session = createEmptySessionState({
      id: "memory-refresh",
      workingDir,
    });
    await loop.runTurn(session, {
      userMessage: "fix cart total",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    expect(providerInputs.length).toBeGreaterThanOrEqual(2);
    expect(providerInputs[0]).toMatchObject({
      userMessage: "fix cart total",
      toolResultSummaries: [],
    });
    expect(providerInputs[1]?.toolResultSummaries).toContain(
      "noop: read src/cart.ts",
    );
  });

  it("does not inject a notice when consecutive steps differ", async () => {
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run(args) {
        return {
          tool: "noop",
          status: "ok",
          summary: `noop:${(args as { n?: number })?.n ?? 0}`,
          details: {},
          truncated: false,
        };
      },
    });
    const prompts: string[] = [];
    let n = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async ({ prompt }) => {
        prompts.push(prompt);
        n += 1;
        if (n >= 4) {
          return makeCompletion(
            JSON.stringify({ tool: "reply", args: { text: "done" } }),
          );
        }
        return makeCompletion(JSON.stringify({ tool: "noop", args: { n } }));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({
      id: "s-nodiff",
      workingDir,
    });
    await loop.runTurn(session, {
      userMessage: "varied",
      maxSteps: 8,
      signal: new AbortController().signal,
    });
    const NOTICE_MARK = /same arguments \d+ times/;
    expect(prompts.every((p) => !NOTICE_MARK.test(p))).toBe(true);
  });

  it("continues the turn when a tool throws and records the error as a tool result", async () => {
    const registry = buildDefaultToolRegistry();
    let flakyCalls = 0;
    registry.register({
      name: "flaky",
      description: "throws on first call, succeeds after",
      readonly: true,
      async run() {
        flakyCalls += 1;
        if (flakyCalls === 1) {
          throw new Error("locator.click: Timeout 30000ms exceeded.");
        }
        return {
          tool: "flaky",
          status: "ok",
          summary: "recovered",
          details: {},
          truncated: false,
        };
      },
    });
    let call = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        call += 1;
        if (call === 1) {
          return makeCompletion(JSON.stringify({ tool: "flaky", args: {} }));
        }
        if (call === 2) {
          return makeCompletion(JSON.stringify({ tool: "flaky", args: {} }));
        }
        return makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "done" } }),
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({
      id: "s-flaky",
      workingDir,
    });
    const result = await loop.runTurn(session, {
      userMessage: "try something",
      maxSteps: 5,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
    expect(result.session.status).toBe("pending");
    expect(result.stepCount).toBe(3);
    const toolResults = result.session.turns.filter(
      (turn): turn is Extract<typeof turn, { kind: "tool_result" }> =>
        turn.kind === "tool_result",
    );
    expect(toolResults[0]).toMatchObject({
      tool: "flaky",
      status: "error",
    });
    expect(toolResults[0]?.summary).toMatch(/Timeout/);
    expect(toolResults[1]).toMatchObject({
      tool: "flaky",
      status: "ok",
    });
  });

  it("emits assistant_delta and reasoning_delta events when a streaming LLM is wired", async () => {
    const registry = buildDefaultToolRegistry();
    const events: Array<{ type: string; text?: string }> = [];
    const raw =
      '<think>short plan</think>{"tool":"reply","args":{"text":"hello stream"}}';
    async function* streamCompletion(): AsyncGenerator<
      { delta: string; reasoningDelta: string; done: boolean },
      CompletionResult,
      void
    > {
      for (const ch of raw) {
        yield { delta: ch, reasoningDelta: "", done: false };
      }
      yield { delta: "", reasoningDelta: "", done: true };
      return makeCompletion(raw);
    }
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => makeCompletion(raw),
      llmCompleteStream: () => streamCompletion(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "llm_event") {
          const inner = event.event;
          if (
            inner.type === "assistant_delta" ||
            inner.type === "reasoning_delta" ||
            inner.type === "assistant_reply"
          ) {
            events.push({
              type: inner.type,
              text: "text" in inner ? inner.text : undefined,
            });
          }
        }
      },
    });
    const session = createEmptySessionState({ id: "s-stream", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "hi",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
    const reasoningDeltas = events.filter((e) => e.type === "reasoning_delta");
    const assistantDeltas = events.filter((e) => e.type === "assistant_delta");
    expect(reasoningDeltas.map((e) => e.text).join("")).toBe("short plan");
    expect(assistantDeltas.map((e) => e.text).join("")).toBe("hello stream");
    // Terminal assistant_reply still arrives with the full canonical body.
    const finalReply = events.find((e) => e.type === "assistant_reply");
    expect(finalReply?.text).toBe("hello stream");
  });

  it("respects an external abort signal", async () => {
    const registry = buildDefaultToolRegistry();
    const controller = new AbortController();
    controller.abort();
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion('{"tool":"finish","args":{"summary":"never"}}'),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({ id: "s", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "g",
      maxSteps: 3,
      signal: controller.signal,
    });
    expect(result.reason).toBe("cancelled");
    expect(result.session.status).toBe("cancelled");
  });

  it("classifies a truncated completion as ModelError with exactly one LLM call", async () => {
    const registry = buildDefaultToolRegistry();
    let llmCalls = 0;
    const stepErrors: Array<{ category: string; message: string }> = [];
    const parseRetries: number[] = [];
    let loopFailedCategory: string | null = null;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        llmCalls += 1;
        return {
          ...makeCompletion(
            '{"tool":"finish","args":{"summary":"never finis',
          ),
          truncated: true,
        };
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "llm_event" && event.event.type === "step_error") {
          stepErrors.push({
            category: event.event.category,
            message: event.event.error.message,
          });
        } else if (
          event.type === "llm_event" &&
          event.event.type === "parse_retry"
        ) {
          parseRetries.push(event.event.attempt);
        } else if (event.type === "loop_failed") {
          loopFailedCategory = event.category;
        }
      },
    });
    const session = createEmptySessionState({ id: "s-truncated", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "go",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("failed");
    expect(result.session.status).toBe("failed");
    expect(llmCalls).toBe(1);
    expect(parseRetries).toHaveLength(0);
    expect(stepErrors).toHaveLength(1);
    expect(stepErrors[0]?.category).toBe("model");
    expect(loopFailedCategory).toBe("model");
  });

  it("classifies an empty completion as ModelError and skips parse retry", async () => {
    const registry = buildDefaultToolRegistry();
    let llmCalls = 0;
    const stepErrors: Array<{ category: string }> = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        llmCalls += 1;
        return makeCompletion("");
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "llm_event" && event.event.type === "step_error") {
          stepErrors.push({ category: event.event.category });
        }
      },
    });
    const session = createEmptySessionState({ id: "s-empty", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "go",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("failed");
    expect(result.session.status).toBe("failed");
    expect(llmCalls).toBe(1);
    expect(stepErrors[0]?.category).toBe("model");
  });

  it("soft-fails persistent parse failure with a graceful reply after one retry", async () => {
    const registry = buildDefaultToolRegistry();
    let llmCalls = 0;
    const stepErrors: Array<{ category: string }> = [];
    const parseRetries: number[] = [];
    const loopFailed: unknown[] = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        llmCalls += 1;
        return makeCompletion("not valid json at all");
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "llm_event" && event.event.type === "step_error") {
          stepErrors.push({ category: event.event.category });
        } else if (
          event.type === "llm_event" &&
          event.event.type === "parse_retry"
        ) {
          parseRetries.push(event.event.attempt);
        } else if (event.type === "loop_failed") {
          loopFailed.push(event);
        }
      },
    });
    const session = createEmptySessionState({ id: "s-grammar", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "go",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    // Issue #37: small-model junk must not hard-fail the session.
    expect(result.reason).toBe("reply");
    expect(result.session.status).not.toBe("failed");
    expect(llmCalls).toBe(2);
    expect(parseRetries).toHaveLength(1);
    expect(stepErrors[0]?.category).toBe("grammar");
    expect(loopFailed).toHaveLength(0);
    const last = result.session.turns.at(-1);
    expect(last?.kind).toBe("assistant_reply");
    if (last?.kind === "assistant_reply") {
      expect(last.text).toContain("not a valid tool call");
    }
  });

  it("classifies a missing tool call as ToolExecutionError", async () => {
    const registry = buildDefaultToolRegistry();
    const stepErrors: Array<{ category: string; message: string }> = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(
          JSON.stringify({ tool: "does_not_exist", args: {} }),
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "llm_event" && event.event.type === "step_error") {
          stepErrors.push({
            category: event.event.category,
            message: event.event.error.message,
          });
        }
      },
    });
    const session = createEmptySessionState({ id: "s-missing", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "go",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("failed");
    expect(result.session.status).toBe("failed");
    expect(result.session.lastError).toMatch(/does_not_exist/);
    expect(stepErrors[0]?.category).toBe("tool");
    expect(stepErrors[0]?.message).toMatch(/does_not_exist/);
  });

  it("refreshes profile at turn start when the operator hot-swaps the llama-server model", async () => {
    const registry = buildDefaultToolRegistry();
    const qwenGrammar = await buildGrammar(QWEN_THINK_PROFILE);
    const gemmaGrammar = await buildGrammar(GEMMA4_THINK_PROFILE);

    // The agent starts pointed at Qwen, but by the time this turn kicks
    // off the operator has swapped the loaded model to Gemma. The
    // turn-start `/props` probe must pick that up before step 0 builds
    // its prompt.
    const fetchProps = vi.fn<[], Promise<Record<string, unknown>>>();
    fetchProps.mockResolvedValue(GEMMA4_PROPS);
    const fakeLlama = { fetchProps } as unknown as LlamaServerClient;

    const profileManager = new ModelProfileManager({
      llama: fakeLlama,
      initialProfile: QWEN_THINK_PROFILE,
      initialGrammar: qwenGrammar,
      initialModelId: "qwen3-30b-a3b-instruct-2507",
    });

    // Pre-close both reasoning channels so the completion parses
    // regardless of whether Qwen or Gemma tags are active when the step
    // runs — the assertion that matters is the manager state after the
    // turn completes.
    const toolCall = (name: string, args: Record<string, unknown>) =>
      `</think><channel|>${JSON.stringify({ tool: name, args })}`;

    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: qwenGrammar,
      profile: QWEN_THINK_PROFILE,
      profileManager,
      llmComplete: async () =>
        makeCompletion(
          toolCall("finish", { summary: "done" }),
          "gemma-4-it",
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });

    const session = createEmptySessionState({ id: "s-hotswap", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "go",
      maxSteps: 2,
      signal: new AbortController().signal,
    });

    expect(result.reason).toBe("finish");
    expect(fetchProps).toHaveBeenCalled();
    expect(profileManager.getProfile().id).toBe("gemma4-think");
    expect(profileManager.getGrammar()).toBe(gemmaGrammar);
    expect(profileManager.getModelId()).toBe("gemma-4-it");
  });

  it("refreshes profile between steps when a completion reports a foreign modelId mid-turn", async () => {
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        return {
          tool: "noop",
          status: "ok",
          summary: "noop",
          details: {},
          truncated: false,
        };
      },
    });
    const qwenGrammar = await buildGrammar(QWEN_THINK_PROFILE);
    const gemmaGrammar = await buildGrammar(GEMMA4_THINK_PROFILE);

    // Turn-start probe still sees the original Qwen model — the swap
    // happens only between step 0 and step 1.
    const fetchProps = vi.fn<[], Promise<Record<string, unknown>>>();
    fetchProps.mockResolvedValueOnce(QWEN3_PROPS);
    fetchProps.mockResolvedValue(GEMMA4_PROPS);
    const fakeLlama = { fetchProps } as unknown as LlamaServerClient;

    const profileManager = new ModelProfileManager({
      llama: fakeLlama,
      initialProfile: QWEN_THINK_PROFILE,
      initialGrammar: qwenGrammar,
      initialModelId: "qwen3-30b-a3b-instruct-2507",
    });

    const toolCall = (name: string, args: Record<string, unknown>) =>
      `</think><channel|>${JSON.stringify({ tool: name, args })}`;

    const completions: CompletionResult[] = [
      // Step 0: served by Qwen still (modelId matches baseline).
      makeCompletion(
        toolCall("noop", {}),
        "qwen3-30b-a3b-instruct-2507",
      ),
      // Step 1: server has been hot-swapped to Gemma. Reactive refresh
      // must pick it up before step 2 starts.
      makeCompletion(
        toolCall("noop", {}),
        "gemma-4-it",
      ),
      // Step 2: close the turn so the loop doesn't stall.
      makeCompletion(
        toolCall("finish", { summary: "ok" }),
        "gemma-4-it",
      ),
    ];
    let callIndex = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: qwenGrammar,
      profile: QWEN_THINK_PROFILE,
      profileManager,
      llmComplete: async () => completions[callIndex++]!,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });

    const session = createEmptySessionState({
      id: "s-hotswap-mid",
      workingDir,
    });
    const result = await loop.runTurn(session, {
      userMessage: "go",
      maxSteps: 4,
      signal: new AbortController().signal,
    });

    expect(result.reason).toBe("finish");
    // Turn-start probe + reactive probe after the Gemma completion.
    expect(fetchProps).toHaveBeenCalledTimes(2);
    expect(profileManager.getProfile().id).toBe("gemma4-think");
    expect(profileManager.getGrammar()).toBe(gemmaGrammar);
    expect(profileManager.getModelId()).toBe("gemma-4-it");
  });
});

describe("AgentLoop reflection hook", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-agent-loop-reflect-"));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function makeReplyLoop(
    reflectionRunner: {
      reflect: (input: {
        sessionId: string;
        userMessage: string;
        assistantReply: string;
      }) => Promise<void>;
      abortPending: () => void;
    } | undefined,
  ): AgentLoop {
    const registry = buildDefaultToolRegistry();
    return new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "hello back" } }),
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      ...(reflectionRunner ? { reflectionRunner } : {}),
    });
  }

  it("does NOT call abortPending() per turn (avoids abort race) but fires reflect() after a reply", async () => {
    const abortPending = vi.fn();
    const reflect = vi.fn().mockResolvedValue(undefined);
    const loop = makeReplyLoop({ reflect, abortPending });

    const session = createEmptySessionState({ id: "s-ref-1", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "hi there",
      maxSteps: 3,
      signal: new AbortController().signal,
    });

    expect(result.reason).toBe("reply");
    // Per-turn abortPending was removed — it cancelled in-flight
    // reflection LLM calls before they could write to memory in
    // long-running scenarios (LoCoMo / LongMemEval), pinning 0
    // reflection writes across 75+ turn runs. Race protection
    // between fires on the same session is enforced inside
    // `ReflectionRunner.runOne` (the new reflect() call aborts the
    // previous controller before starting). Shutdown still calls
    // `abortPending()` (no sessionId) to drain everything.
    expect(abortPending).not.toHaveBeenCalled();
    expect(reflect).toHaveBeenCalledTimes(1);
    // Phase 7a — `turnIndex` is threaded into `ReflectionInput` so
    // the vote-runner can stamp `vote_events.turn_index`. The exact
    // value tracks `state.turns.length` after the assistant reply
    // lands; assertion uses `objectContaining` so subsequent
    // phases can extend the input without re-breaking this test.
    expect(reflect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s-ref-1",
        userMessage: "hi there",
        assistantReply: "hello back",
        turnIndex: expect.any(Number),
      }),
    );
  });

  it("does not fire reflect() when runTurn is resumed without a new user message", async () => {
    const abortPending = vi.fn();
    const reflect = vi.fn().mockResolvedValue(undefined);
    const loop = makeReplyLoop({ reflect, abortPending });

    const session = createEmptySessionState({ id: "s-ref-2", workingDir });
    await loop.runTurn(session, {
      maxSteps: 3,
      signal: new AbortController().signal,
    });

    // Per-turn abortPending was removed (see "does NOT call
    // abortPending() per turn" test). Reflection still must not
    // fire without a user message in this turn.
    expect(abortPending).not.toHaveBeenCalled();
    expect(reflect).not.toHaveBeenCalled();
  });

  it("behaves identically when no reflectionRunner is provided", async () => {
    const loop = makeReplyLoop(undefined);
    const session = createEmptySessionState({ id: "s-ref-3", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "hi",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
  });

  it("never awaits reflect() — a slow runner does not block runTurn", async () => {
    const abortPending = vi.fn();
    let resolveReflect: (() => void) | null = null;
    const reflect = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveReflect = () => resolve();
        }),
    );
    const loop = makeReplyLoop({ reflect, abortPending });

    const session = createEmptySessionState({ id: "s-ref-4", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "hi",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
    expect(reflect).toHaveBeenCalledTimes(1);
    // The runner promise is still outstanding — runTurn resolved anyway.
    expect(resolveReflect).not.toBeNull();
    resolveReflect?.();
  });

  it("swallows reflect() errors without affecting the loop result", async () => {
    const abortPending = vi.fn();
    const reflect = vi.fn().mockRejectedValue(new Error("boom"));
    const loop = makeReplyLoop({ reflect, abortPending });

    const session = createEmptySessionState({ id: "s-ref-5", workingDir });
    await expect(
      loop.runTurn(session, {
        userMessage: "hi",
        maxSteps: 3,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ reason: "reply" });
  });

  it("does not fire reflect() on a finish-only turn (no assistant reply)", async () => {
    const abortPending = vi.fn();
    const reflect = vi.fn().mockResolvedValue(undefined);
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(
          JSON.stringify({ tool: "finish", args: { summary: "done" } }),
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      reflectionRunner: { reflect, abortPending },
    });
    const session = createEmptySessionState({ id: "s-ref-6", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "wrap up",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("finish");
    expect(reflect).not.toHaveBeenCalled();
    // Per-turn abortPending removed — see top of describe block.
    expect(abortPending).not.toHaveBeenCalled();
  });
});
