import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "./agent-loop.js";
import type { AgentLoopEvent } from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { osFsReadTool } from "../tools/os/fs-read.js";
import { SlotManager } from "../llm/slot-manager.js";
import { TransportError } from "../llm/reliability/llm-failures.js";
import { LlamaServerError } from "../llm/llama-server-client.js";
import { PARSE_RECOVERY_BUDGET } from "./parse-failure-recovery.js";
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

  it("keeps working past the leg length while the task is progressing", async () => {
    // The point of the change: `maxSteps` is a checkpoint, not the end
    // of the work. A task that is still getting usable results out of
    // its tools must not stop because a counter says 2.
    const registry = buildDefaultToolRegistry();
    let noopRuns = 0;
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        noopRuns += 1;
        return {
          tool: "noop",
          status: "ok",
          summary: `noop ${noopRuns}`,
          details: { run: noopRuns },
          truncated: false,
        };
      },
    });
    const continued: Array<{ stepsTaken: number; stepCeiling: number }> = [];
    let calls = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        calls += 1;
        // Seven working steps, then the model finishes on its own.
        return makeCompletion(
          calls <= 7
            ? JSON.stringify({ tool: "noop", args: { n: calls } })
            : JSON.stringify({ tool: "reply", args: { text: "all done" } }),
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "task_continued") {
          continued.push({
            stepsTaken: event.stepsTaken,
            stepCeiling: event.stepCeiling,
          });
        }
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-legs", workingDir }),
      {
        userMessage: "long job",
        maxSteps: 2,
        taskMaxSteps: 20,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("reply");
    expect(noopRuns).toBe(7);
    // Three leg boundaries crossed (steps 2, 4, 6), each reported.
    expect(continued.map((c) => c.stepsTaken)).toEqual([2, 4, 6]);
    expect(continued.every((c) => c.stepCeiling === 20)).toBe(true);
  });

  it("stops at the ceiling, not at the leg, and says which", async () => {
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        return {
          tool: "noop",
          status: "ok" as const,
          summary: "noop",
          details: {},
          truncated: false,
        };
      },
    });
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(JSON.stringify({ tool: "noop", args: {} })),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-ceiling", workingDir }),
      {
        userMessage: "endless",
        maxSteps: 2,
        taskMaxSteps: 6,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("max_steps");
    // Six steps spent, of which the last is the reserved summary the
    // model refused to write — so five tool steps landed in the session.
    expect(result.session.lastError).toMatch(
      /task_stopped:step_ceiling: 6 steps/,
    );
    expect(result.session.stepCount).toBe(5);
  });

  it("stops when a whole leg produced nothing usable", async () => {
    // The environment-is-broken case from the field: every call fails,
    // so there is nothing to continue towards. Stop after one leg
    // rather than burning the ceiling on a dead tool.
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        return {
          tool: "noop",
          status: "error" as const,
          summary: "tool exploded",
          details: {},
          truncated: false,
        };
      },
    });
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(JSON.stringify({ tool: "noop", args: {} })),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-noprogress", workingDir }),
      {
        userMessage: "doomed",
        maxSteps: 2,
        taskMaxSteps: 50,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("max_steps");
    // One leg, and the leg check at the boundary — not 50 steps of it.
    expect(result.session.stepCount).toBe(2);
    expect(result.session.lastError).toMatch(/task_stopped:no_progress/);
    expect(result.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: expect.stringContaining("nothing came back"),
    });
  });

  it("parks the turn on a transport failure and resumes when the provider answers", async () => {
    // The field case: the provider stops answering mid-task. Killing
    // the turn throws away the work already done and makes every later
    // message fail in one second; waiting keeps the task alive.
    const registry = buildDefaultToolRegistry();
    let noopRuns = 0;
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        noopRuns += 1;
        return {
          tool: "noop",
          status: "ok" as const,
          summary: `noop ${noopRuns}`,
          details: {},
          truncated: false,
        };
      },
    });
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    let calls = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        calls += 1;
        // Step 0 works, the provider dies for two attempts, then it is
        // back and the task finishes.
        if (calls === 1) {
          return makeCompletion(JSON.stringify({ tool: "noop", args: {} }));
        }
        if (calls <= 3) {
          throw new TransportError("fetch failed", null, "");
        }
        return makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "back online" } }),
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "provider_waiting" || event.type === "provider_recovered") {
          events.push(event as { type: string } & Record<string, unknown>);
        }
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-park", workingDir }),
      {
        userMessage: "keep going",
        maxSteps: 10,
        taskMaxSteps: 10,
        signal: new AbortController().signal,
      },
    );

    expect(result.reason).toBe("reply");
    // Two outages waited out, then one recovery notice.
    expect(events.map((e) => e.type)).toEqual([
      "provider_waiting",
      "provider_waiting",
      "provider_recovered",
    ]);
    // Backoff grows, and the budget is reported so a UI can show it.
    expect(events[0]!.nextRetryMs).toBe(2_000);
    expect(events[1]!.nextRetryMs).toBe(4_000);
    expect(events[0]!.reason).toBe("fetch failed");
    // The parked attempts are not steps and replay nothing: one tool
    // step plus the reply, not four steps and two noops.
    expect(noopRuns).toBe(1);
    expect(result.session.stepCount).toBe(2);
    // Four completions were requested (one good, two dead, one good) —
    // the same step was retried, not a new one started.
    expect(calls).toBe(4);
  });

  it("retries a step whose reply spent the cap, with a bigger cap and a notice", async () => {
    // A reasoning model thinks past `max_tokens` before it emits the tool
    // call. The old outcome was `Turn failed [model]: model response
    // truncated`; the same request would hit the same wall, so the retry
    // is a different one.
    const registry = buildDefaultToolRegistry();
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const capsSeen: Array<number | undefined> = [];
    const prompts: string[] = [];
    let calls = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async ({ maxTokens, prompt }) => {
        calls += 1;
        capsSeen.push(maxTokens);
        prompts.push(prompt);
        if (calls === 1) {
          return {
            ...makeCompletion(""),
            reasoningContent: "Let me think about this at great length",
            stop: false,
            truncated: true,
            usage: { promptTokens: 6_000, completionTokens: 8_192, totalTokens: 14_192 },
          };
        }
        return makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "short answer" } }),
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "completion_truncated" || event.type === "loop_failed") {
          events.push(event as { type: string } & Record<string, unknown>);
        }
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-trunc-cap", workingDir }),
      {
        userMessage: "write the module",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: new AbortController().signal,
      },
    );

    expect(result.reason).toBe("reply");
    expect(calls).toBe(2);
    // The first completion ran under the config cap; the retry under 4×.
    expect(capsSeen[0]).toBeUndefined();
    expect(capsSeen[1]).toBe(32_768);
    // The model is told why it is being asked again.
    expect(prompts[1]).toContain("cut off after 8192 tokens");
    expect(prompts[1]).toContain("Keep your reasoning brief");
    expect(prompts[0]).not.toContain("cut off after");
    // One event, carrying the cause and the retry; no failure.
    expect(events).toEqual([
      expect.objectContaining({
        type: "completion_truncated",
        stepIndex: 0,
        cause: "reply_cap",
        completionTokens: 8_192,
        promptTokens: 6_000,
        requestedMaxTokens: 8_192,
        retry: { kind: "raise_cap", maxTokens: 32_768 },
      }),
    ]);
    // A retried step is one step.
    expect(result.session.stepCount).toBe(1);
  });

  it("retries a cut on a leg boundary instead of calling the leg unproductive", async () => {
    // A retry re-enters the loop at the same index. If that index is a
    // leg boundary, the boundary check must not run a second time: its
    // first pass reset the progress flag, and a second pass would read
    // the retry as a whole leg with nothing to show.
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        return { tool: "noop", status: "ok" as const, summary: "noop", details: {}, truncated: false };
      },
    });
    const kinds: string[] = [];
    let calls = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        calls += 1;
        if (calls <= 2) return makeCompletion(JSON.stringify({ tool: "noop", args: {} }));
        if (calls === 3) {
          return {
            ...makeCompletion(""),
            stop: false,
            truncated: true,
            usage: { promptTokens: 6_000, completionTokens: 8_192, totalTokens: 14_192 },
          };
        }
        return makeCompletion(JSON.stringify({ tool: "reply", args: { text: "done" } }));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (
          event.type === "task_continued" ||
          event.type === "completion_truncated" ||
          event.type === "loop_completed"
        ) {
          kinds.push(event.type === "loop_completed" ? `loop_completed:${event.reason}` : event.type);
        }
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-trunc-leg", workingDir }),
      {
        userMessage: "keep going",
        maxSteps: 2,
        taskMaxSteps: 10,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("reply");
    expect(calls).toBe(4);
    expect(kinds).toEqual(["task_continued", "completion_truncated", "loop_completed:reply"]);
  });

  it("retries a cut on the finalization step, where a reasoning model is likeliest to think past the cap", async () => {
    const registry = buildDefaultToolRegistry();
    let calls = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ...makeCompletion(""),
            stop: false,
            truncated: true,
            usage: { promptTokens: 6_000, completionTokens: 8_192, totalTokens: 14_192 },
          };
        }
        return makeCompletion(JSON.stringify({ tool: "reply", args: { text: "summary" } }));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-trunc-final", workingDir }),
      {
        userMessage: "summarise",
        // One step: it is the finalization step from the start.
        maxSteps: 1,
        taskMaxSteps: 1,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("reply");
    expect(calls).toBe(2);
  });

  it("keeps the notice the cut attempt carried on the retry", async () => {
    const registry = buildDefaultToolRegistry();
    const prompts: string[] = [];
    let calls = 0;
    let drained = false;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async ({ prompt }) => {
        calls += 1;
        prompts.push(prompt);
        if (calls === 1) {
          return {
            ...makeCompletion(""),
            stop: false,
            truncated: true,
            usage: { promptTokens: 6_000, completionTokens: 8_192, totalTokens: 14_192 },
          };
        }
        return makeCompletion(JSON.stringify({ tool: "reply", args: { text: "ok" } }));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      steeringInbox: {
        open: () => {},
        drain: () => {
          if (drained) return [];
          drained = true;
          return ["also add the tests"];
        },
        closeAndDrain: () => [],
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-trunc-notice", workingDir }),
      {
        userMessage: "write it",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("reply");
    expect(prompts[0]).toContain("also add the tests");
    expect(prompts[1]).toContain("also add the tests");
    expect(prompts[1]).toContain("cut off after 8192 tokens");
  });

  it("forgets a learned window the server just proved too small", async () => {
    const registry = buildDefaultToolRegistry();
    const exceeded: number[] = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => ({
        ...makeCompletion(JSON.stringify({ tool: "reply", args: { text: "ok" } })),
        usage: { promptTokens: 20_000, completionTokens: 500, totalTokens: 20_500 },
      }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      contextWindow: () => 16_384,
      onContextWindowExceeded: (tokens) => exceeded.push(tokens),
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-trunc-unlearn", workingDir }),
      { userMessage: "hi", maxSteps: 5, taskMaxSteps: 5, signal: new AbortController().signal },
    );
    expect(result.reason).toBe("reply");
    expect(exceeded).toEqual([20_500]);
  });

  it("fails the turn on the second cut of the same step, naming the wall", async () => {
    const registry = buildDefaultToolRegistry();
    const failures: string[] = [];
    let calls = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async ({ maxTokens }) => {
        calls += 1;
        const cap = maxTokens ?? 8_192;
        return {
          ...makeCompletion(""),
          stop: false,
          truncated: true,
          usage: { promptTokens: 6_000, completionTokens: cap, totalTokens: 6_000 + cap },
        };
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "loop_failed") {
          failures.push(`${event.category}: ${event.error.message}`);
        }
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-trunc-twice", workingDir }),
      {
        userMessage: "write the module",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("failed");
    expect(calls).toBe(2);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("model: model response truncated at 32768 tokens");
    expect(failures[0]).toContain("localModels.completionMaxTokens");
    expect(result.session.lastError).toContain("model response truncated");
  });

  it("learns the context window when the reply stopped short of the cap, and retries under it", async () => {
    // Lemonade / llama.cpp sized the window below the model's advertised
    // one; the runtime believed the catalogue. Prompt + reply *is* the
    // window, so the retry is packed to it.
    const registry = buildDefaultToolRegistry();
    const observed: number[] = [];
    let learned: number | null = null;
    const prompts: string[] = [];
    let calls = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async ({ prompt, maxTokens }) => {
        calls += 1;
        prompts.push(prompt);
        if (calls === 1) {
          return {
            ...makeCompletion(""),
            stop: false,
            truncated: true,
            usage: { promptTokens: 30_000, completionTokens: 2_768, totalTokens: 32_768 },
          };
        }
        // Same cap as the first attempt: the window was the wall, not the cap.
        expect(maxTokens).toBeUndefined();
        return makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "fits now" } }),
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      contextWindow: () => learned,
      onContextWindowObserved: (contextWindow) => {
        observed.push(contextWindow);
        learned = contextWindow;
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-trunc-window", workingDir }),
      {
        userMessage: "keep going",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("reply");
    expect(observed).toEqual([32_768]);
    expect(prompts[1]).toContain("ran out of context");
    expect(calls).toBe(2);
  });

  it("fails with the truncation, not the 400, when the provider refuses the raised cap", async () => {
    const registry = buildDefaultToolRegistry();
    const failures: string[] = [];
    let calls = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ...makeCompletion(""),
            stop: false,
            truncated: true,
            usage: { promptTokens: 6_000, completionTokens: 8_192, totalTokens: 14_192 },
          };
        }
        throw new TransportError('"vendor" rejected the request (400).', 400, "https://x/v1", {
          cause: new Error("max_tokens is too large: 32768. This model supports at most 16384 completion tokens"),
        });
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "loop_failed") {
          failures.push(`${event.category}: ${event.error.message}`);
        }
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-trunc-400", workingDir }),
      {
        userMessage: "write the module",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("failed");
    expect(calls).toBe(2);
    expect(failures[0]).toContain("model: model response truncated at 8192 tokens");
    expect(failures[0]).not.toContain("rejected the request");
  });

  it("does not wait out a failure that will never fix itself", async () => {
    // `transport` also covers a wrong URL answering 404 and a dead key
    // answering 401. Parking a turn for five minutes in front of a typo
    // is worse than the failure it replaces — the operator would get no
    // message at all until the budget ran out.
    const registry = buildDefaultToolRegistry();
    const waits: unknown[] = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        throw new TransportError("not found", 404, "http://127.0.0.1:8080/v1");
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "provider_waiting") waits.push(event);
      },
    });
    const started = Date.now();
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-park-404", workingDir }),
      {
        userMessage: "wrong url",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("failed");
    expect(waits).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("waits out a 503, which is exactly the kind that fixes itself", async () => {
    const registry = buildDefaultToolRegistry();
    const waits: unknown[] = [];
    let calls = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TransportError("service unavailable", 503, "https://x/v1");
        }
        return makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "recovered" } }),
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "provider_waiting") waits.push(event);
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-park-503", workingDir }),
      {
        userMessage: "busy provider",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("reply");
    expect(waits).toHaveLength(1);
  });

  it("gives up after the wait budget and fails the turn once", async () => {
    const registry = buildDefaultToolRegistry();
    const waits: number[] = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        throw new TransportError("fetch failed", null, "");
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "provider_waiting") waits.push(event.nextRetryMs);
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-park-out", workingDir }),
      {
        userMessage: "hopeless",
        maxSteps: 5,
        taskMaxSteps: 5,
        // Two waits: 2s, then 1s clipped to the remaining budget.
        providerWaitMaxMs: 3_000,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("failed");
    expect(waits).toEqual([2_000, 1_000]);
  });

  it("an abort during the wait stops the turn immediately", async () => {
    const registry = buildDefaultToolRegistry();
    const controller = new AbortController();
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        // The operator presses Esc while the turn is parked.
        setTimeout(() => controller.abort(), 5);
        throw new TransportError("fetch failed", null, "");
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const started = Date.now();
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-park-abort", workingDir }),
      {
        userMessage: "stop me",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: controller.signal,
      },
    );
    expect(result.reason).toBe("cancelled");
    // Returned on the abort, not after the full 2s backoff.
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("providerWaitEnabled: false fails the turn as it used to", async () => {
    const registry = buildDefaultToolRegistry();
    const waits: unknown[] = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        throw new TransportError("fetch failed", null, "");
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "provider_waiting") waits.push(event);
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-park-off", workingDir }),
      {
        userMessage: "fail fast",
        maxSteps: 5,
        taskMaxSteps: 5,
        providerWaitEnabled: false,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("failed");
    expect(waits).toEqual([]);
  });

  it("stops on the wall clock and says so", async () => {
    // A task that never finishes must be bounded by time as well as by
    // steps: 1000 fast steps and 1000 slow ones are very different asks.
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        return {
          tool: "noop",
          status: "ok" as const,
          summary: "noop",
          details: {},
          truncated: false,
        };
      },
    });
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(JSON.stringify({ tool: "noop", args: {} })),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-clock", workingDir }),
      {
        userMessage: "slow job",
        maxSteps: 5,
        taskMaxSteps: 500,
        // Already expired when the first step checks.
        taskMaxDurationMs: 1,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("max_steps");
    expect(result.session.lastError).toMatch(/task_stopped:time_ceiling/);
    expect(result.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: expect.stringContaining("time limit"),
    });
  });

  it("autoContinue: false keeps the historical one-leg behaviour", async () => {
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        return {
          tool: "noop",
          status: "ok" as const,
          summary: "noop",
          details: {},
          truncated: false,
        };
      },
    });
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(JSON.stringify({ tool: "noop", args: {} })),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-noauto", workingDir }),
      {
        userMessage: "one leg only",
        maxSteps: 3,
        autoContinue: false,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("max_steps");
    // Three steps, the third reserved for the summary: one leg, exactly
    // as before this existed.
    expect(result.session.lastError).toMatch(
      /task_stopped:step_ceiling: 3 steps/,
    );
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

  it("marks the session as failed when the LLM emits a botched tool call", async () => {
    const registry = buildDefaultToolRegistry();
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => makeCompletion('[{"tool":"reply","args":{'),
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
    expect(result.reason).toBe("failed");
    expect(result.session.status).toBe("failed");
    expect(result.session.lastError).toMatch(/tool-call/);
  });

  it("degrades to a plain reply when the LLM answers in prose instead of a tool call", async () => {
    const registry = buildDefaultToolRegistry();
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => makeCompletion("Hi! How can I help?"),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({ id: "s-prose", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "hi",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
    expect(result.session.status).toBe("pending");
    expect(result.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "Hi! How can I help?",
    });
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
      // The ceiling, stated: `maxSteps` is only the leg length now, so a
      // test about running out has to say what it is running out of.
      taskMaxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("max_steps");
    expect(result.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      // Names the ceiling and what to do next, instead of an internal
      // counter nobody outside this repo has heard of.
      text: expect.stringContaining("step ceiling"),
    });
    expect(result.session.turns.at(-1)).toMatchObject({
      text: expect.stringContaining("continue"),
    });
    expect(result.session.status).toBe("stalled");
    expect(result.session.lastError).toMatch(/task_stopped:step_ceiling: 2 steps/);
  });

  it("reserves the final step for a terminal reply", async () => {
    const registry = buildDefaultToolRegistry();
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        return {
          tool: "noop",
          status: "ok",
          summary: "verified",
          details: {},
          truncated: false,
        };
      },
    });
    let calls = 0;
    const prompts: string[] = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async (params) => {
        calls += 1;
        prompts.push(params.prompt);
        return makeCompletion(
          calls === 1
            ? JSON.stringify({ tool: "noop", args: {} })
            : JSON.stringify({ tool: "reply", args: { text: "verified" } }),
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "chat-finalize", workingDir }),
      {
        userMessage: "verify",
        maxSteps: 2,
        // The reserved final step now sits at the task ceiling.
        taskMaxSteps: 2,
        signal: new AbortController().signal,
      },
    );

    expect(calls).toBe(2);
    expect(prompts[1]).toContain("final allowed step");
    expect(result.reason).toBe("reply");
    expect(result.stepCount).toBe(2);
    expect(result.session.status).toBe("pending");
    expect(result.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "verified",
    });
  });

  it("keeps the cancelled outcome when the user aborts during the finalization step", async () => {
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
    let calls = 0;
    const controller = new AbortController();
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        calls += 1;
        if (calls === 1) {
          return makeCompletion(JSON.stringify({ tool: "noop", args: {} }));
        }
        // The user presses Esc while the reserved final inference is in
        // flight — the provider surfaces it as an abort.
        controller.abort();
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "chat-finalize-cancel", workingDir }),
      {
        userMessage: "verify",
        maxSteps: 2,
        taskMaxSteps: 2,
        signal: controller.signal,
      },
    );

    expect(calls).toBe(2);
    expect(result.reason).toBe("cancelled");
    expect(result.session.status).toBe("cancelled");
    expect(result.session.lastError ?? "").not.toMatch(/max_steps/);
  });

  it("gives the finalization step one repair attempt, then preserves the stalled outcome", async () => {
    const registry = buildDefaultToolRegistry();
    let noopRuns = 0;
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        noopRuns += 1;
        return {
          tool: "noop",
          status: "ok",
          summary: "noop",
          details: {},
          truncated: false,
        };
      },
    });
    let calls = 0;
    const stepEventTypes: string[] = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      // The model insists on a non-terminal tool even on the reserved
      // final step and its repair attempt.
      llmComplete: async () => {
        calls += 1;
        return makeCompletion(JSON.stringify({ tool: "noop", args: {} }));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "llm_event") stepEventTypes.push(event.event.type);
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "chat-finalize-stubborn", workingDir }),
      {
        userMessage: "verify",
        maxSteps: 2,
        // The reserved final step now sits at the task ceiling.
        taskMaxSteps: 2,
        signal: new AbortController().signal,
      },
    );

    // Step 0 executes the tool; the finalization step burns its first
    // completion plus exactly one repair round-trip, and neither may
    // execute the non-terminal call.
    expect(calls).toBe(3);
    expect(noopRuns).toBe(1);
    expect(stepEventTypes.filter((t) => t === "parse_retry")).toHaveLength(1);
    expect(result.reason).toBe("max_steps");
    expect(result.session.status).toBe("stalled");
    expect(result.session.lastError).toMatch(
      /task_stopped:step_ceiling: 2 steps/,
    );
    expect(result.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: expect.stringContaining("step ceiling"),
    });
  });

  it("treats the only step of a maxSteps=1 turn as terminal — no tool can ever run", async () => {
    const registry = buildDefaultToolRegistry();
    let noopRuns = 0;
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        noopRuns += 1;
        return {
          tool: "noop",
          status: "ok",
          summary: "noop",
          details: {},
          truncated: false,
        };
      },
    });
    let calls = 0;
    const prompts: string[] = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async (params) => {
        calls += 1;
        prompts.push(params.prompt);
        return makeCompletion(
          calls === 1
            ? JSON.stringify({ tool: "noop", args: {} })
            : JSON.stringify({ tool: "reply", args: { text: "summary only" } }),
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "chat-one-step", workingDir }),
      {
        userMessage: "hi",
        maxSteps: 1,
        taskMaxSteps: 1,
        signal: new AbortController().signal,
      },
    );

    // With a budget of one, the single step IS the finalization step:
    // the tool call is rejected before execution and the repair pass
    // must produce the terminal reply.
    expect(prompts[0]).toContain("final allowed step");
    expect(calls).toBe(2);
    expect(noopRuns).toBe(0);
    expect(result.reason).toBe("reply");
    expect(result.session.status).toBe("pending");
    expect(result.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "summary only",
    });
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

  it("warns on the second no-progress re-read of one unchanged file", async () => {
    // The read-coverage detector (issue #114) end to end, through the
    // production path: the real `os.fs.read`, the real batch gate, the
    // agent-loop's own threshold branch and notice formatting. Every one
    // of the three reads below hashes to a different argument signature,
    // so nothing but the coverage detector can see that the second and
    // third returned only lines the first already showed.
    const registry = buildDefaultToolRegistry();
    registry.register(osFsReadTool);
    const body = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(workingDir, "src.ts"), `${body}\n`, "utf8");
    const script = [
      { tool: "os.fs.read", args: { path: "src.ts" } },
      { tool: "os.fs.read", args: { path: "src.ts", offset: 40, limit: 30 } },
      { tool: "os.fs.read", args: { path: "src.ts", offset: 90, limit: 30 } },
      { tool: "finish", args: { summary: "done" } },
    ];
    const prompts: string[] = [];
    const detected: Extract<AgentLoopEvent, { type: "loop_detected" }>[] = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async ({ prompt }) => {
        const step = prompts.length;
        prompts.push(prompt);
        return makeCompletion(
          JSON.stringify(script[Math.min(step, script.length - 1)]),
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "loop_detected") detected.push(event);
        if (process.env.DBG && event.type === "loop_failed") console.log("ERRMSG", (event as any).error?.message);
      },
    });
    const session = createEmptySessionState({ id: "s-read-loop", workingDir });
    await loop.runTurn(session, {
      userMessage: "look at src.ts",
      maxSteps: 6,
      signal: new AbortController().signal,
    });

    // Exactly one warning, and it lands on the SECOND no-progress read —
    // the detector's own floor of 2, not the generic warning threshold of
    // 3, which would never have been reached inside this turn.
    expect(detected).toHaveLength(1);
    const event = detected[0]!;
    expect(event.detector).toBe("read_repeat");
    expect(event.level).toBe("warn");
    expect(event.count).toBe(2);
    expect(event.tool).toBe("os.fs.read");
    // The payload acceptance criterion 8 asks for: which file, which
    // range came back, and the fingerprints on either side. Equal
    // fingerprints are the evidence that the content did not move.
    expect(event.read?.path).toContain("src.ts");
    expect(event.read?.startLine).toBe(90);
    expect(event.read?.endLine).toBe(119);
    expect(event.read?.fingerprint).toBeTruthy();
    expect(event.read?.previousFingerprint).toBe(event.read?.fingerprint);
    // Line numbers and a path only — no line of the file in the event.
    expect(JSON.stringify(event)).not.toContain("line 90");

    // The read-specific notice — not the generic repeat one — reaches the
    // next prompt. The generic notice talks about repeated ARGUMENTS,
    // which is precisely the thing that was never true here.
    const after = prompts.slice(3).join("\n");
    expect(after).toContain("without reaching a line you had not already read");
    expect(after).toContain("Already read this turn: lines 1-200");
    expect(after).not.toMatch(/same arguments \d+ times/);
    // No notice before the detector fired.
    expect(prompts.slice(0, 3).join("\n")).not.toContain(
      "without reaching a line you had not already read",
    );
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

  it("repairs an empty completion once, then classifies it as ModelError", async () => {
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
    // An empty grammar body now goes through the one-shot repair (a
    // rebuilt prompt, not a replay) before the turn is written off — two
    // calls, never three. A second empty completion is still terminal
    // and still classifies as `model`.
    expect(llmCalls).toBe(2);
    expect(stepErrors[0]?.category).toBe("model");
  });

  it("classifies persistent parse failure as GrammarError after the recovery budget", async () => {
    const registry = buildDefaultToolRegistry();
    let llmCalls = 0;
    const stepErrors: Array<{ category: string }> = [];
    const parseRetries: number[] = [];
    const recoveries: Array<{ attempt: number; budget: number }> = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        llmCalls += 1;
        return makeCompletion('[{"tool":"reply","args":{"text":');
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
        } else if (event.type === "parse_failure_recovered") {
          recoveries.push({ attempt: event.attempt, budget: event.budget });
        }
      },
    });
    const session = createEmptySessionState({ id: "s-grammar", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "go",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("failed");
    expect(result.session.status).toBe("failed");
    // Each step gets the step executor's own one-shot repair (2 calls);
    // the turn then spends `PARSE_RECOVERY_BUDGET` further steps on a
    // rebuilt prompt before giving up. A model that cannot emit a valid
    // call three times running still fails, and still as `grammar`.
    expect(recoveries).toEqual([
      { attempt: 1, budget: PARSE_RECOVERY_BUDGET },
      { attempt: 2, budget: PARSE_RECOVERY_BUDGET },
    ]);
    expect(llmCalls).toBe(2 * (PARSE_RECOVERY_BUDGET + 1));
    expect(parseRetries).toHaveLength(PARSE_RECOVERY_BUDGET + 1);
    expect(stepErrors[0]?.category).toBe("grammar");
  });

  it("recovers a rejected tool call by spending a step on a corrected one", async () => {
    const registry = buildDefaultToolRegistry();
    let llmCalls = 0;
    const prompts: string[] = [];
    const recoveries: number[] = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async (params) => {
        llmCalls += 1;
        prompts.push(params.prompt);
        // The first step and its in-step repair both come back
        // unparseable — the shape a large `os.fs.write` produces when
        // the repair's own token cap cannot fit the argument again.
        return llmCalls <= 2
          ? makeCompletion('[{"tool":"os.fs.write","args":{"path":"/tmp/x","content":"aaa')
          : makeCompletion(JSON.stringify({ tool: "reply", args: { text: "done" } }));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "parse_failure_recovered") recoveries.push(event.attempt);
      },
    });
    const session = createEmptySessionState({ id: "s-parse-recovered", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "write the file",
      maxSteps: 5,
      signal: new AbortController().signal,
    });
    // The turn answers instead of dying, without the operator noticing
    // the silence and typing "try again".
    expect(result.reason).toBe("reply");
    expect(result.session.status).toBe("pending");
    expect(recoveries).toEqual([1]);
    // The step after the rejection is told what was rejected — the
    // feedback the model had no way to get before.
    const afterRecovery = prompts[2] ?? "";
    expect(afterRecovery).toContain("rejected before any tool ran");
    expect(afterRecovery).toContain("Nothing you attempted has happened yet");
    const replies = result.session.turns.filter((t) => t.kind === "assistant_reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: "done" });
  });

  it("leaves the failure in the transcript so the next turn is not blind", async () => {
    const registry = buildDefaultToolRegistry();
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion('[{"tool":"reply","args":{"text":'),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({ id: "s-failure-record", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "go",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("failed");
    const last = result.session.turns[result.session.turns.length - 1];
    expect(last?.kind).toBe("assistant_reply");
    expect((last as { text: string }).text).toContain("this turn failed");
    expect((last as { text: string }).text).toContain("grammar");
    expect((last as { text: string }).text).toContain("Nothing from it took effect");
  });

  it("does not recover a request the model server itself rejected", async () => {
    const registry = buildDefaultToolRegistry();
    let llmCalls = 0;
    const recoveries: number[] = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        llmCalls += 1;
        throw new LlamaServerError("request too large", 413, "http://x/v1");
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "parse_failure_recovered") recoveries.push(event.attempt);
      },
    });
    const session = createEmptySessionState({ id: "s-413", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "go",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    // A 413 wears the same `GrammarError` shape, but re-prompting
    // reproduces it: the operator gets the diagnosis now, not two
    // wasted steps later.
    expect(result.reason).toBe("failed");
    expect(recoveries).toEqual([]);
    expect(llmCalls).toBe(1);
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
