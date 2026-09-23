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
import { OpenAiHttpError } from "../llm/provider/openai/openai-http.js";
import { parseProviderErrorBody } from "../llm/provider/openai/parse-provider-error-body.js";
import { PARSE_RECOVERY_BUDGET } from "./parse-failure-recovery.js";
import { EMPTY_COMPLETION_RECOVERY_BUDGET } from "./empty-completion-recovery.js";
import { createEmptySessionState } from "../session/session-state.js";
import type {
  CompletionResult,
  LlamaServerClient,
} from "../llm/llama-server-client.js";
import { ModelProfileManager } from "../llm/model-profile-manager.js";
import { GEMMA4_PROPS, QWEN3_PROPS } from "../llm/model-profile.fixtures.js";
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
    timing: {
      promptMs: 1,
      predictedMs: 1,
      promptTokens: 10,
      predictedTokens: 5,
    },
    cacheHitTokens: 0,
    slotId: 0,
    modelId,
  };
}

/**
 * A completion as a native-tools provider returns one: everything in
 * `tool_calls`, nothing in `content`. Called with no arguments it is the
 * wholly-empty completion behind Sentry CLI-BA — no content, no
 * reasoning, no calls.
 */
function makeNativeCompletion(
  toolCalls?: Array<{ name: string; arguments: string }>,
): CompletionResult {
  return {
    ...makeCompletion("", "openai/gpt-5.5"),
    slotId: -1,
    ...(toolCalls === undefined
      ? {}
      : {
          toolCalls: toolCalls.map((call, index) => ({
            id: `call-${index}`,
            type: "function" as const,
            function: call,
          })),
        }),
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

  it("pins RunTurnOptions.originalRequest into the prompt once its turn is dropped (F22)", async () => {
    // The record the workers' briefs quote, now reaching the
    // orchestrator's own prompt: a repair turn still sees the spec.
    const registry = buildDefaultToolRegistry();
    const tails: string[] = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(JSON.stringify({ tool: "reply", args: { text: "done" } })),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "llm_event" && event.event.type === "prompt_captured") {
          tails.push(event.event.tail);
        }
      },
    });
    const spec = `Build it: ${"detail ".repeat(30_000)}`;
    const session = createEmptySessionState({ id: "s-request", workingDir });
    session.turns.push({ kind: "user", text: spec, at: 1 });
    session.turns.push({ kind: "assistant_reply", text: "built", at: 2 });
    await loop.runTurn(session, {
      userMessage: "fix these bugs",
      originalRequest: spec,
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(tails).toHaveLength(1);
    expect(tails[0]).toContain("### request");
    expect(tails[0]!.indexOf("### request")).toBeLessThan(tails[0]!.indexOf("### conversation"));
  });

  it("passes RunTurnOptions.reasoningEffort / maxOutputTokens to every completion (F20)", async () => {
    const registry = buildDefaultToolRegistry();
    const seen: Array<{ effort?: string; cap?: number }> = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async (params) => {
        seen.push({
          ...(params.reasoningEffort === undefined ? {} : { effort: params.reasoningEffort }),
          ...(params.maxOutputTokens === undefined ? {} : { cap: params.maxOutputTokens }),
        });
        return makeCompletion(JSON.stringify({ tool: "reply", args: { text: "done" } }));
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({ id: "s-effort", workingDir });
    await loop.runTurn(session, {
      userMessage: "go",
      reasoningEffort: "low",
      maxOutputTokens: 12_000,
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    await loop.runTurn(session, {
      userMessage: "again",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(seen).toEqual([{ effort: "low", cap: 12_000 }, {}]);
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
    // model refused to write: its tool call was not run — it landed as
    // a refusal in the transcript — so five tool calls ran.
    expect(result.session.lastError).toMatch(
      /task_stopped:step_ceiling: 6 steps/,
    );
    expect(result.session.stepCount).toBe(6);
    const results = result.session.turns.filter(
      (turn) => turn.kind === "tool_result",
    );
    expect(results).toHaveLength(6);
    expect(results.slice(0, 5).every((turn) => turn.status === "ok")).toBe(
      true,
    );
    expect(results.at(-1)).toMatchObject({
      status: "error",
      summary: "final step: only reply or finish run here",
    });
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
        if (
          event.type === "provider_waiting" ||
          event.type === "provider_recovered"
        ) {
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
            usage: {
              promptTokens: 6_000,
              completionTokens: 16_384,
              totalTokens: 22_384,
            },
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
        if (
          event.type === "completion_truncated" ||
          event.type === "loop_failed"
        ) {
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
    // The first completion ran under the config cap (16,384); the retry
    // under 4× of it, clamped to the 32,768 ceiling.
    expect(capsSeen[0]).toBeUndefined();
    expect(capsSeen[1]).toBe(32_768);
    // The model is told why it is being asked again.
    expect(prompts[1]).toContain("cut off after 16384 tokens");
    expect(prompts[1]).toContain("Keep your reasoning brief");
    expect(prompts[0]).not.toContain("cut off after");
    // One event, carrying the cause and the retry; no failure.
    expect(events).toEqual([
      expect.objectContaining({
        type: "completion_truncated",
        stepIndex: 0,
        cause: "reply_cap",
        completionTokens: 16_384,
        promptTokens: 6_000,
        requestedMaxTokens: 16_384,
        retry: { kind: "raise_cap", maxTokens: 32_768 },
      }),
    ]);
    // A retried step is one step.
    expect(result.session.stepCount).toBe(1);
  });

  it("retries a cut the provider made with no cap on the wire, without claiming a cap was spent", async () => {
    // Request cloud-00312: no `max_tokens`, cut at 33,678 tokens, logged
    // as "spent the reply cap … of 8192" with `requestedMaxTokens: 8192`.
    // The retry that sent 32,768 then succeeded — so it stays.
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
            reasoningContent: "Let me write every file out first",
            stop: false,
            truncated: true,
            sentMaxTokens: null,
            usage: {
              promptTokens: 21_000,
              completionTokens: 33_678,
              totalTokens: 54_678,
            },
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
        if (
          event.type === "completion_truncated" ||
          event.type === "loop_failed"
        ) {
          events.push(event as { type: string } & Record<string, unknown>);
        }
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-trunc-nocap", workingDir }),
      {
        userMessage: "write the module",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: new AbortController().signal,
      },
    );

    expect(result.reason).toBe("reply");
    expect(calls).toBe(2);
    expect(capsSeen).toEqual([undefined, 32_768]);
    expect(prompts[1]).toContain("cut off after 33678 tokens");
    expect(events).toEqual([
      expect.objectContaining({
        type: "completion_truncated",
        stepIndex: 0,
        cause: "provider_limit",
        completionTokens: 33_678,
        promptTokens: 21_000,
        retry: { kind: "raise_cap", maxTokens: 32_768 },
      }),
    ]);
    expect(events[0]).not.toHaveProperty("requestedMaxTokens");
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
        return {
          tool: "noop",
          status: "ok" as const,
          summary: "noop",
          details: {},
          truncated: false,
        };
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
        if (calls <= 2)
          return makeCompletion(JSON.stringify({ tool: "noop", args: {} }));
        if (calls === 3) {
          return {
            ...makeCompletion(""),
            stop: false,
            truncated: true,
            usage: {
              promptTokens: 6_000,
              completionTokens: 16_384,
              totalTokens: 22_384,
            },
          };
        }
        return makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "done" } }),
        );
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
          kinds.push(
            event.type === "loop_completed"
              ? `loop_completed:${event.reason}`
              : event.type,
          );
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
    expect(kinds).toEqual([
      "task_continued",
      "completion_truncated",
      "loop_completed:reply",
    ]);
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
            usage: {
              promptTokens: 6_000,
              completionTokens: 16_384,
              totalTokens: 22_384,
            },
          };
        }
        return makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "summary" } }),
        );
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
            usage: {
              promptTokens: 6_000,
              completionTokens: 16_384,
              totalTokens: 22_384,
            },
          };
        }
        return makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "ok" } }),
        );
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
    expect(prompts[1]).toContain("cut off after 16384 tokens");
  });

  it("reports a completion that exceeded the learned window, so bootstrap can raise it", async () => {
    const registry = buildDefaultToolRegistry();
    const exceeded: number[] = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => ({
        ...makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "ok" } }),
        ),
        usage: {
          promptTokens: 20_000,
          completionTokens: 500,
          totalTokens: 20_500,
        },
      }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      contextWindow: () => 16_384,
      onContextWindowExceeded: (tokens) => exceeded.push(tokens),
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-trunc-unlearn", workingDir }),
      {
        userMessage: "hi",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: new AbortController().signal,
      },
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
        // No cap on the first call: the step runs under the config
        // default (16,384); the retry carries the raised 32,768.
        const cap = maxTokens ?? 16_384;
        return {
          ...makeCompletion(""),
          stop: false,
          truncated: true,
          usage: {
            promptTokens: 6_000,
            completionTokens: cap,
            totalTokens: 6_000 + cap,
          },
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
    expect(failures[0]).toContain(
      "model: model response truncated at 32768 tokens",
    );
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
            usage: {
              promptTokens: 30_000,
              completionTokens: 2_768,
              totalTokens: 32_768,
            },
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

  it("learns the window a native-tool provider names in its 400, repacks and retries once (F30)", async () => {
    const registry = buildDefaultToolRegistry();
    const observed: number[] = [];
    const repacks: Array<{ contextWindow: number; source: string }> = [];
    const prompts: string[] = [];
    let learned: number | null = null;
    let calls = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      toolTransport: "native_tools",
      toolCallAdapter: null,
      llmComplete: async ({ prompt }) => {
        calls += 1;
        prompts.push(prompt);
        if (calls === 1) {
          throw new TransportError(
            '"vendor" rejected the request (400).',
            400,
            "https://x/v1",
            {
              cause: new OpenAiHttpError(
                "openai provider 400: This model's maximum context length is 8192 tokens. However, you requested 9134 tokens (7134 in the messages, 2000 in the completion).",
                400,
                "u",
              ),
            },
          );
        }
        return makeNativeCompletion([
          { name: "reply", arguments: JSON.stringify({ text: "fits now" }) },
        ]);
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      contextWindow: () => learned,
      onContextWindowObserved: (contextWindow) => {
        observed.push(contextWindow);
        learned = contextWindow;
      },
      onEvent: (event) => {
        if (event.type === "prompt_repacked") repacks.push(event);
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-size-400", workingDir }),
      {
        userMessage: "keep going",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("reply");
    expect(calls).toBe(2);
    expect(observed).toEqual([8_192]);
    expect(repacks).toEqual([
      expect.objectContaining({ contextWindow: 8_192, source: "provider", stepIndex: 0 }),
    ]);
    expect(prompts[1]).toContain("trimmed to fit this model's window");
    // The same step, not a new one.
    expect(result.session.stepCount).toBe(1);
  });

  it("packs to most of the prompt estimate when the 413 names no window, and fails on a second refusal (F30)", async () => {
    const registry = buildDefaultToolRegistry();
    const observed: number[] = [];
    const failures: string[] = [];
    let promptTokens = 0;
    let calls = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      toolTransport: "native_tools",
      toolCallAdapter: null,
      llmComplete: async () => {
        calls += 1;
        throw new TransportError(
          '"vendor" rejected the request (413).',
          413,
          "https://x/v1",
          {
            cause: new OpenAiHttpError(
              "openai provider 413: the request exceeds the available context size",
              413,
              "u",
            ),
          },
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      contextWindow: () => null,
      onContextWindowObserved: (contextWindow) => observed.push(contextWindow),
      onEvent: (event) => {
        if (event.type === "llm_event" && event.event.type === "prompt_built") {
          promptTokens = event.event.prompt.tokens.total;
        }
        if (event.type === "loop_failed") failures.push(event.error.message);
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-size-413", workingDir }),
      {
        userMessage: "keep going",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("failed");
    expect(calls).toBe(2);
    expect(promptTokens).toBeGreaterThan(0);
    expect(observed).toEqual([Math.floor(promptTokens * 0.8)]);
    expect(failures[0]).toContain("rejected the request (413)");
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
            usage: {
              promptTokens: 6_000,
              completionTokens: 16_384,
              totalTokens: 22_384,
            },
          };
        }
        throw new TransportError(
          '"vendor" rejected the request (400).',
          400,
          "https://x/v1",
          {
            cause: new Error(
              "max_tokens is too large: 32768. This model supports at most 16384 completion tokens",
            ),
          },
        );
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
    expect(failures[0]).toContain(
      "model: model response truncated at 16384 tokens",
    );
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

  it("does not wait out our own request deadline (issue #490)", async () => {
    // A first-token timeout is `status === null` — there is no HTTP
    // response to carry a status — so it used to classify as an outage
    // and get parked and replayed. With the shipped 30-minute
    // `firstTokenTimeoutMs`, a server that queues the request forever
    // then burns a 45-minute fusion worker on two silent attempts and
    // reports `max_steps` with `stepCount: 0`. Our clock running out is
    // not evidence about the provider: surface it on the first attempt.
    const registry = buildDefaultToolRegistry();
    const waits: unknown[] = [];
    let calls = 0;
    let failure = "";
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        calls += 1;
        throw new LlamaServerError(
          "llama-server sent no first token within 1800000ms — it may still be " +
            "evaluating the prompt or queued behind other requests; raise " +
            "ATOMIC_AGENT_LLAMA_FIRST_TOKEN_TIMEOUT_MS (localModels.firstTokenTimeoutMs)",
          null,
          "http://127.0.0.1:8080/completion",
          true,
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "provider_waiting") waits.push(event);
        if (event.type === "loop_failed") failure = event.error.message;
      },
    });
    const started = Date.now();
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-first-token-deadline", workingDir }),
      {
        userMessage: "build the thing",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("failed");
    expect(waits).toEqual([]);
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
    // And the operator reads which deadline expired and which knob
    // raises it, not a generic transport failure.
    expect(failure).toContain("no first token within 1800000ms");
    expect(failure).toContain("localModels.firstTokenTimeoutMs");
  });

  it("still waits out a transport failure that never had a status (issue #490)", async () => {
    // The narrowing above is on `timedOut`, not on `status === null`.
    // A refused connection while llama-server restarts wears the same
    // statusless shape and is exactly what the park exists for.
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
          throw new LlamaServerError(
            "fetch failed",
            null,
            "http://127.0.0.1:8080/completion",
            false,
            "ECONNREFUSED",
          );
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
      createEmptySessionState({ id: "s-econnrefused", workingDir }),
      {
        userMessage: "server restarting",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("reply");
    expect(waits).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("stops the turn resumable when the provider's body says the credit is exhausted (F29)", async () => {
    // The Codex attempt: a 429 carrying `credit_balance_exhausted` was
    // parked and retried as rate limiting, 42 times per worker.
    const registry = buildDefaultToolRegistry();
    const events: string[] = [];
    let calls = 0;
    const body = JSON.stringify({
      error: {
        message: "Provider returned error",
        code: 429,
        metadata: {
          raw: '{"error":{"type":"credit_balance_exhausted","message":"Your credit balance is too low"}}',
        },
      },
    });
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        calls += 1;
        throw new TransportError(
          '"openrouter" is rate-limiting this key (429).',
          429,
          "https://openrouter.ai/api/v1",
          {
            cause: new OpenAiHttpError(
              `openai provider 429: ${body}`,
              429,
              "https://openrouter.ai/api/v1/chat/completions",
              false,
              null,
              "openrouter",
              undefined,
              { body: parseProviderErrorBody(body) },
            ),
          },
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (
          event.type === "provider_waiting" ||
          event.type === "credit_exhausted" ||
          event.type === "loop_failed" ||
          event.type === "loop_completed"
        ) {
          events.push(event.type);
        }
      },
    });
    const started = Date.now();
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-credit", workingDir }),
      {
        userMessage: "keep going",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: new AbortController().signal,
      },
    );
    // One request, no park, no failure: paused where it stood.
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(events).toEqual(["credit_exhausted", "loop_completed"]);
    expect(result.reason).toBe("max_steps");
    expect(result.stopCause).toBe("credit_exhausted");
    expect(result.session.status).toBe("stalled");
    expect(result.session.lastError).toBe(
      'task_stopped:credit_exhausted: "openrouter" is out of credit after 0 steps',
    );
    const last = result.session.turns.at(-1);
    expect(last?.kind).toBe("assistant_reply");
    expect((last as { text: string }).text).toContain(
      '"openrouter" reports the account is out of credit',
    );
    expect((last as { text: string }).text).toContain("say `continue`");
  });

  it("waits as long as the provider asked, on a 402 the outage wait would otherwise refuse (F29)", async () => {
    // OpenRouter's `in_flight_budget_exhausted` with a retry hint ended
    // a cloud-only run at 2m19s as final. The hint is honoured instead.
    const registry = buildDefaultToolRegistry();
    const waits: Array<{ nextRetryMs: number }> = [];
    let calls = 0;
    const body = JSON.stringify({
      error: {
        code: "in_flight_budget_exhausted",
        message: "Too many requests in flight for your balance; retry in 1 s",
      },
    });
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TransportError(
            '"openrouter" refused the request for lack of credit (402).',
            402,
            "https://openrouter.ai/api/v1",
            {
              cause: new OpenAiHttpError(
                `openai provider 402: ${body}`,
                402,
                "https://openrouter.ai/api/v1/chat/completions",
                false,
                null,
                "openrouter",
                undefined,
                { body: parseProviderErrorBody(body) },
              ),
            },
          );
        }
        return makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "budget freed" } }),
        );
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
      createEmptySessionState({ id: "s-inflight", workingDir }),
      {
        userMessage: "busy balance",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("reply");
    expect(calls).toBe(2);
    expect(waits).toHaveLength(1);
    // The hint (1 s), not the 2 s backoff.
    expect(waits[0]!.nextRetryMs).toBe(1_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(Date.now() - started).toBeLessThan(1_900);
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
    expect(result.session.lastError).toMatch(
      /task_stopped:step_ceiling: 2 steps/,
    );
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

  it("refuses a non-terminal call on the final step with a tool result, then preserves the stalled outcome", async () => {
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
      // final step.
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

    // Step 0 executes the tool; the finalization step's call is answered
    // with a refusal instead of running — no repair round-trip, no
    // second inference — and the turn stops at the ceiling.
    expect(calls).toBe(2);
    expect(noopRuns).toBe(1);
    expect(stepEventTypes.filter((t) => t === "parse_retry")).toHaveLength(0);
    expect(result.reason).toBe("max_steps");
    expect(result.session.status).toBe("stalled");
    expect(result.session.lastError).toMatch(
      /task_stopped:step_ceiling: 2 steps/,
    );
    expect(result.session.turns.at(-2)).toMatchObject({
      kind: "tool_result",
      tool: "noop",
      status: "error",
      summary: "final step: only reply or finish run here",
    });
    expect(result.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: expect.stringContaining("step ceiling"),
    });
  });

  it("keeps the full tool catalog and the same stable prefix on the final step", async () => {
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
            : JSON.stringify({ tool: "reply", args: { text: "done" } }),
        );
      },
      toolDescriptors: [
        ...TOOLS,
        { name: "noop", summary: "No-op.", argsSchema: "{}" },
      ],
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    await loop.runTurn(
      createEmptySessionState({ id: "chat-finalize-prefix", workingDir }),
      {
        userMessage: "verify",
        maxSteps: 2,
        taskMaxSteps: 2,
        signal: new AbortController().signal,
      },
    );
    expect(prompts).toHaveLength(2);
    // The stable prefix — everything ahead of the first tail section —
    // is byte-identical between the ordinary step and the final one; a
    // catalog narrowed to reply/finish used to change it and move the
    // session to a cold slot for its last step.
    const prefix = (p: string) => p.slice(0, p.indexOf("### world"));
    expect(prefix(prompts[1]!)).toBe(prefix(prompts[0]!));
    expect(prompts[1]).toContain("noop");
    expect(prompts[1]).toContain("final allowed step");
  });

  it("lets a [tool, reply] batch on the final step keep its reply and refuse the tool", async () => {
    // A real pure-read name, so the batch validator lets `[read, reply]`
    // through to the dispatch gate (an unregistered name would be
    // rejected as a batch member before any gate ran).
    const registry = buildDefaultToolRegistry();
    let readRuns = 0;
    registry.register({
      name: "os.fs.read",
      description: "read",
      readonly: true,
      async run() {
        readRuns += 1;
        return {
          tool: "os.fs.read",
          status: "ok",
          summary: "hello",
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
        makeCompletion(
          JSON.stringify([
            { tool: "os.fs.read", args: { path: "notes.txt" } },
            { tool: "reply", args: { text: "here is the summary" } },
          ]),
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "chat-finalize-tail", workingDir }),
      {
        userMessage: "verify",
        maxSteps: 1,
        taskMaxSteps: 1,
        signal: new AbortController().signal,
      },
    );
    expect(readRuns).toBe(0);
    expect(result.reason).toBe("reply");
    expect(result.stopCause).toBe("step_ceiling");
    expect(result.session.turns.at(-2)).toMatchObject({
      kind: "tool_result",
      tool: "os.fs.read",
      status: "error",
      summary: "final step: only reply or finish run here",
    });
    expect(result.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "here is the summary",
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
    // the tool call is refused at dispatch — it never runs, there is no
    // repair pass — and the turn stops at the ceiling with the refusal
    // on record.
    expect(prompts[0]).toContain("final allowed step");
    expect(calls).toBe(1);
    expect(noopRuns).toBe(0);
    expect(result.reason).toBe("max_steps");
    expect(result.session.status).toBe("stalled");
    expect(result.session.turns.at(-2)).toMatchObject({
      kind: "tool_result",
      tool: "noop",
      status: "error",
      summary: "final step: only reply or finish run here",
    });
    expect(result.session.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: expect.stringContaining("step ceiling"),
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
    const body = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
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
        if (process.env.DBG && event.type === "loop_failed")
          console.log("ERRMSG", (event as any).error?.message);
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

  it("warns once the same result has come back three times, whatever the arguments (F25)", async () => {
    // The outcome-repeat detector end to end: a probe that answers the
    // same thing to three different questions. No argument-keyed
    // detector can see it (three distinct signatures), the tool is not a
    // read (no coverage), and no command is recognised as a test.
    const registry = buildDefaultToolRegistry();
    let runCount = 0;
    registry.register({
      name: "probe",
      description: "probe",
      readonly: true,
      async run() {
        runCount += 1;
        return {
          tool: "probe",
          status: "error",
          summary: "SyntaxError: Unexpected token } (line 128)",
          details: {},
          truncated: false,
        };
      },
    });
    const script = [
      { tool: "probe", args: { n: 1 } },
      { tool: "probe", args: { n: 2 } },
      { tool: "probe", args: { n: 3 } },
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
      },
    });
    const session = createEmptySessionState({ id: "s-outcome-loop", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "check it",
      maxSteps: 6,
      signal: new AbortController().signal,
    });
    // Warn only: every probe ran and the turn ended on the model's own
    // `finish`, not on a veto or a breaker.
    expect(runCount).toBe(3);
    expect(result.reason).toBe("finish");
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({
      detector: "outcome_repeat",
      level: "warn",
      count: 3,
      tool: "probe",
    });
    // The notice lands on the prompt AFTER the third identical result.
    expect(prompts[3]).toContain("Same result three times from `probe`");
    expect(prompts[3]).toContain("change approach or write");
    expect(prompts.slice(0, 3).join("\n")).not.toContain("change approach or write");
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
      text: expect.stringMatching(/no-progress outcome/),
    });
    // The refusal count is the tracker's, not the detector streak: with
    // these defaults exactly 4 calls were refused (three vetoes trip the
    // breaker, and the call that reads it is refused too) while the
    // no-progress streak plateaued at 5. The reply used to announce
    // "after 5 blocked attempts" — a refusal that never happened.
    const forcedReply = (result.session.turns.at(-1) as { text: string }).text;
    expect(forcedReply).toContain(
      "refused 4 times in a row, counting this one",
    );
    expect(forcedReply).not.toMatch(/blocked attempts/i);
    expect(forcedReply).not.toContain("5");
    // A breaker-level loop_detected event was surfaced.
    expect(detectedEvents.some((e) => e.level === "breaker")).toBe(true);
    // Critical vetoes prevented the tool from running every step — the
    // veto plateau means `noop` ran far fewer times than the step budget.
    expect(runCount).toBeLessThan(12);
  });

  // Issue #458: a wandering escalation rides the breaker path, and the
  // forced reply used to call a turn of distinct, successful fetches a
  // "no-progress loop" with "blocked attempts".
  it("words the forced reply for a wandering stop as a spread cap, not a repeat", async () => {
    const registry = buildDefaultToolRegistry();
    let runCount = 0;
    registry.register({
      name: "os.web.fetch",
      description: "fetch",
      readonly: true,
      async run(args) {
        runCount += 1;
        const url = (args as { url?: string }).url ?? "";
        return {
          tool: "os.web.fetch",
          status: "ok",
          summary: `content of ${url}`,
          details: {},
          truncated: false,
        };
      },
    });
    const detected: Array<{ level?: string; detector?: string; count: number }> =
      [];
    let step = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        step += 1;
        return makeCompletion(
          JSON.stringify({
            tool: "os.web.fetch",
            args: { url: `https://example.com/file-${step}.ts` },
          }),
        );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "loop_detected") {
          detected.push({
            level: event.level,
            detector: event.detector,
            count: event.count,
          });
        }
      },
    });
    const session = createEmptySessionState({
      id: "s-wandering-breaker",
      workingDir,
    });
    // Default escalation is 12: eleven distinct fetches run, the twelfth
    // reaches the cap and is vetoed, and the turn ends gracefully.
    const result = await loop.runTurn(session, {
      userMessage: "read these files",
      maxSteps: 20,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
    expect(runCount).toBe(11);
    expect(detected.at(-1)).toMatchObject({
      level: "breaker",
      detector: "wandering",
      count: 12,
    });
    const last = result.session.turns.at(-1);
    expect(last).toMatchObject({ kind: "assistant_reply" });
    const text = (last as { text: string }).text;
    expect(text).toContain("hit the limit on different arguments");
    expect(text).toContain("12, counting the last call");
    expect(text).not.toMatch(/no-progress|blocked attempts|repeated/i);
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
          ...makeCompletion('{"tool":"finish","args":{"summary":"never finis'),
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
          ? makeCompletion(
              '[{"tool":"os.fs.write","args":{"path":"/tmp/x","content":"aaa',
            )
          : makeCompletion(
              JSON.stringify({ tool: "reply", args: { text: "done" } }),
            );
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "parse_failure_recovered")
          recoveries.push(event.attempt);
      },
    });
    const session = createEmptySessionState({
      id: "s-parse-recovered",
      workingDir,
    });
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
    const replies = result.session.turns.filter(
      (t) => t.kind === "assistant_reply",
    );
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
    const session = createEmptySessionState({
      id: "s-failure-record",
      workingDir,
    });
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
    expect((last as { text: string }).text).toContain(
      "Nothing from it took effect",
    );
  });

  it("recovers a wholly empty native-tools completion by spending a step", async () => {
    // Sentry CLI-BA: on `native_tools` a completion with nothing in any
    // channel has no parse to retry and no repair to run, so before this
    // it ended the turn on the first inference and the operator had to
    // notice the silence and type "try again".
    const registry = buildDefaultToolRegistry();
    let llmCalls = 0;
    const prompts: string[] = [];
    const recoveries: Array<{ attempt: number; budget: number }> = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      toolTransport: "native_tools",
      toolCallAdapter: null,
      llmComplete: async (params) => {
        llmCalls += 1;
        prompts.push(params.prompt);
        return llmCalls === 1
          ? makeNativeCompletion()
          : makeNativeCompletion([
              { name: "reply", arguments: JSON.stringify({ text: "done" }) },
            ]);
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "empty_completion_recovered")
          recoveries.push({ attempt: event.attempt, budget: event.budget });
      },
    });
    const session = createEmptySessionState({ id: "s-empty-nt", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "go",
      maxSteps: 5,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
    expect(result.session.status).toBe("pending");
    expect(recoveries).toEqual([
      { attempt: 1, budget: EMPTY_COMPLETION_RECOVERY_BUDGET },
    ]);
    // The retry is a different request, not a replay: the step that
    // follows is told its predecessor came back empty.
    expect(prompts[1] ?? "").toContain("completely empty");
    expect(prompts[1] ?? "").toContain("Nothing has happened yet");
    const replies = result.session.turns.filter(
      (t) => t.kind === "assistant_reply",
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: "done" });
  });

  it("ends the turn on the second empty native-tools completion, saying so", async () => {
    const registry = buildDefaultToolRegistry();
    let llmCalls = 0;
    const failures: Array<{ category: string; message: string }> = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      toolTransport: "native_tools",
      toolCallAdapter: null,
      llmComplete: async () => {
        llmCalls += 1;
        return makeNativeCompletion();
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "loop_failed")
          failures.push({
            category: event.category,
            message: event.error.message,
          });
      },
    });
    const session = createEmptySessionState({ id: "s-empty-nt2", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "go",
      maxSteps: 5,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("failed");
    expect(result.session.status).toBe("failed");
    // One recovery, then terminal — the budget is not a retry loop.
    expect(llmCalls).toBe(EMPTY_COMPLETION_RECOVERY_BUDGET + 1);
    expect(failures[0]?.category).toBe("model");
    expect(failures[0]?.message).toContain("twice in a row");
  });

  it("does not announce an empty-completion retry it has no step left to spend", async () => {
    // A leg of one: the retry would land on the leg boundary, where a
    // leg that produced nothing usable stops the task. Announcing the
    // retry there would burn the step with ZERO extra inference and
    // swallow the model diagnosis into "ran out of steps" — the
    // operator would read "trying again (1/1)" for a try that never
    // happened, and Sentry would never see the failure.
    const registry = buildDefaultToolRegistry();
    let llmCalls = 0;
    const recoveries: number[] = [];
    const failures: Array<{ category: string; message: string }> = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      toolTransport: "native_tools",
      toolCallAdapter: null,
      llmComplete: async () => {
        llmCalls += 1;
        return makeNativeCompletion();
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "empty_completion_recovered")
          recoveries.push(event.stepIndex);
        if (event.type === "loop_failed")
          failures.push({
            category: event.category,
            message: event.error.message,
          });
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-empty-nt-leg", workingDir }),
      {
        userMessage: "go",
        maxSteps: 1,
        taskMaxSteps: 50,
        signal: new AbortController().signal,
      },
    );
    expect(recoveries).toEqual([]);
    expect(llmCalls).toBe(1);
    expect(result.reason).toBe("failed");
    expect(result.session.status).toBe("failed");
    // The model diagnosis survives — and it does not claim a second
    // attempt that never ran.
    expect(failures[0]?.category).toBe("model");
    expect(failures[0]?.message).toContain("empty");
    expect(failures[0]?.message).not.toContain("twice in a row");
  });

  it("gives a fresh empty-completion retry to an empty that follows a working step", async () => {
    // The budget counts empties IN A ROW. A model that answered a step
    // and then went quiet has just proved the link works, so it gets
    // the same one nudge the first empty got — and the terminal
    // "twice in a row" message is never printed over a working step.
    const registry = buildDefaultToolRegistry();
    registry.register(osFsReadTool);
    writeFileSync(join(workingDir, "src.ts"), "line 1\n", "utf8");
    const script: Array<CompletionResult> = [
      makeNativeCompletion(),
      makeNativeCompletion([
        { name: "os.fs.read", arguments: JSON.stringify({ path: "src.ts" }) },
      ]),
      makeNativeCompletion(),
      makeNativeCompletion([
        { name: "reply", arguments: JSON.stringify({ text: "done" }) },
      ]),
    ];
    let llmCalls = 0;
    const recoveries: Array<{ stepIndex: number; attempt: number }> = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      toolTransport: "native_tools",
      toolCallAdapter: null,
      llmComplete: async () => {
        const completion = script[llmCalls] ?? makeNativeCompletion();
        llmCalls += 1;
        return completion;
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "empty_completion_recovered")
          recoveries.push({
            stepIndex: event.stepIndex,
            attempt: event.attempt,
          });
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-empty-nt-gap", workingDir }),
      {
        userMessage: "go",
        maxSteps: 8,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("reply");
    expect(llmCalls).toBe(4);
    // Two recoveries, each the FIRST of its run — the working step in
    // between cleared the count.
    expect(recoveries).toEqual([
      { stepIndex: 0, attempt: 1 },
      { stepIndex: 2, attempt: 1 },
    ]);
  });

  it("still spends the empty-completion retry when the leg is going to continue", async () => {
    // The other side of the guard above: the retry lands on a leg
    // boundary, but the leg produced something usable, so the boundary
    // continues the task and the retry really does happen. The guard
    // must be about the `no_progress` break, not about boundaries.
    const registry = buildDefaultToolRegistry();
    registry.register(osFsReadTool);
    writeFileSync(join(workingDir, "src.ts"), "line 1\n", "utf8");
    const script: Array<CompletionResult> = [
      makeNativeCompletion([
        { name: "os.fs.read", arguments: JSON.stringify({ path: "src.ts" }) },
      ]),
      makeNativeCompletion(),
      makeNativeCompletion([
        { name: "reply", arguments: JSON.stringify({ text: "done" }) },
      ]),
    ];
    let llmCalls = 0;
    const recoveries: Array<{ stepIndex: number; attempt: number }> = [];
    let continued = 0;
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      toolTransport: "native_tools",
      toolCallAdapter: null,
      llmComplete: async () => {
        const completion = script[llmCalls] ?? makeNativeCompletion();
        llmCalls += 1;
        return completion;
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "empty_completion_recovered")
          recoveries.push({
            stepIndex: event.stepIndex,
            attempt: event.attempt,
          });
        if (event.type === "task_continued") continued += 1;
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-empty-nt-boundary", workingDir }),
      {
        userMessage: "go",
        maxSteps: 2,
        taskMaxSteps: 50,
        signal: new AbortController().signal,
      },
    );
    expect(recoveries).toEqual([{ stepIndex: 1, attempt: 1 }]);
    expect(continued).toBe(1);
    expect(llmCalls).toBe(3);
    expect(result.reason).toBe("reply");
  });

  it("does not announce a parse-failure retry it has no step left to spend", async () => {
    // Same leg-boundary guard on the parse path, which had the same
    // hazard: the retry announced on the last step of a barren leg is
    // never performed, and the operator was handed "ran out of steps"
    // in place of the grammar diagnosis.
    const registry = buildDefaultToolRegistry();
    let llmCalls = 0;
    const recoveries: number[] = [];
    const failures: Array<{ category: string; message: string }> = [];
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
        if (event.type === "parse_failure_recovered")
          recoveries.push(event.stepIndex);
        if (event.type === "loop_failed")
          failures.push({
            category: event.category,
            message: event.error.message,
          });
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-parse-leg", workingDir }),
      {
        userMessage: "go",
        maxSteps: 1,
        taskMaxSteps: 50,
        signal: new AbortController().signal,
      },
    );
    expect(recoveries).toEqual([]);
    // One inference and its in-step repair, and no third.
    expect(llmCalls).toBe(2);
    expect(result.reason).toBe("failed");
    expect(failures[0]?.category).toBe("grammar");
  });

  it("reports the doubled empty when the announced retry lands on the final allowed step", async () => {
    // The retry is announced at step `stepCeiling - 2` and spent at
    // `stepCeiling - 1`, which is the finalization step — and a
    // finalization failure normally ends the turn `max_steps`/`stalled`
    // with `runError` dropped. That would be a REGRESSION: without the
    // recovery this scenario fails on the first empty carrying the
    // model's diagnosis, so swallowing it would hand the operator "ran
    // out of steps" for a promise the turn made and kept, and drop the
    // error report with it. `run --max-steps 2` is the smallest window
    // that reaches it.
    const registry = buildDefaultToolRegistry();
    let llmCalls = 0;
    let recovered = 0;
    const failures: Array<{ category: string; message: string }> = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      toolTransport: "native_tools",
      toolCallAdapter: null,
      llmComplete: async () => {
        llmCalls += 1;
        return makeNativeCompletion();
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (event.type === "empty_completion_recovered") recovered += 1;
        if (event.type === "loop_failed")
          failures.push({
            category: event.category,
            message: event.error.message,
          });
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-empty-nt-final", workingDir }),
      {
        userMessage: "go",
        maxSteps: 2,
        autoContinue: false,
        signal: new AbortController().signal,
      },
    );
    // The retry really happened — this is not the "no step left" guard.
    expect(recovered).toBe(1);
    expect(llmCalls).toBe(2);
    expect(result.reason).toBe("failed");
    expect(result.session.status).toBe("failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.category).toBe("model");
    expect(failures[0]?.message).toContain("twice in a row");
  });

  it("reports the doubled empty when the announced retry lands past the duration ceiling", async () => {
    // The other way a retry lands on a finalization step: the step
    // ceiling is nowhere near, but `agent.task.maxDurationMs` is
    // crossed by the first attempt, so the retry starts `outOfTime`.
    // Same swallow, same fix — and this one is unreachable by the
    // `stepCeiling` arithmetic alone, which is why the guard is on the
    // failure, not on the step count.
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const registry = buildDefaultToolRegistry();
      let llmCalls = 0;
      let recovered = 0;
      const failures: Array<{ category: string; message: string }> = [];
      const loop = new AgentLoop({
        registry,
        slotManager: new SlotManager(2),
        grammar: 'root ::= "ok"',
        toolTransport: "native_tools",
        toolCallAdapter: null,
        llmComplete: async () => {
          llmCalls += 1;
          // Each attempt burns twice the task's whole time budget, so
          // the step after the first one starts past the ceiling.
          clock += 60_000;
          return makeNativeCompletion();
        },
        toolDescriptors: TOOLS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        onEvent: (event) => {
          if (event.type === "empty_completion_recovered") recovered += 1;
          if (event.type === "loop_failed")
            failures.push({
              category: event.category,
              message: event.error.message,
            });
        },
      });
      const result = await loop.runTurn(
        createEmptySessionState({ id: "s-empty-nt-time", workingDir }),
        {
          userMessage: "go",
          maxSteps: 40,
          taskMaxSteps: 40,
          taskMaxDurationMs: 30_000,
          signal: new AbortController().signal,
        },
      );
      expect(recovered).toBe(1);
      expect(llmCalls).toBe(2);
      expect(result.reason).toBe("failed");
      expect(result.session.status).toBe("failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]?.category).toBe("model");
      expect(failures[0]?.message).toContain("twice in a row");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("lets a rejected completion between two empties buy the second one its own retry", async () => {
    // The parse-recovery reset. A body that failed to parse is still
    // tokens on the wire, so the empty that follows it is the FIRST of
    // a new run, not the second of the old one — it gets its own nudge,
    // and the terminal message never says "twice in a row" over a
    // completion that carried something.
    const registry = buildDefaultToolRegistry();
    const script: CompletionResult[] = [
      makeNativeCompletion(),
      // Bad arguments twice: the first is the step's own one-shot
      // repair, the second is what makes the step fail to parse.
      makeNativeCompletion([{ name: "reply", arguments: "{ not json" }]),
      makeNativeCompletion([{ name: "reply", arguments: "{ still not" }]),
      makeNativeCompletion(),
      makeNativeCompletion([
        { name: "reply", arguments: JSON.stringify({ text: "done" }) },
      ]),
    ];
    let llmCalls = 0;
    const events: string[] = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      toolTransport: "native_tools",
      toolCallAdapter: null,
      llmComplete: async () => {
        const completion = script[llmCalls] ?? makeNativeCompletion();
        llmCalls += 1;
        return completion;
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (
          event.type === "empty_completion_recovered" ||
          event.type === "parse_failure_recovered"
        )
          events.push(event.type);
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-empty-nt-parse-reset", workingDir }),
      {
        userMessage: "go",
        maxSteps: 10,
        signal: new AbortController().signal,
      },
    );
    expect(events).toEqual([
      "empty_completion_recovered",
      "parse_failure_recovered",
      "empty_completion_recovered",
    ]);
    expect(llmCalls).toBe(5);
    expect(result.reason).toBe("reply");
  });

  it("lets a cut reply between two empties buy the second one its own retry", async () => {
    // The truncation-retry reset, same argument as the parse one: a
    // reply the server cut short is a link that answered.
    const registry = buildDefaultToolRegistry();
    const script: CompletionResult[] = [
      makeNativeCompletion(),
      {
        ...makeNativeCompletion(),
        stop: false,
        truncated: true,
        usage: {
          promptTokens: 6_000,
          completionTokens: 16_384,
          totalTokens: 22_384,
        },
      },
      makeNativeCompletion(),
      makeNativeCompletion([
        { name: "reply", arguments: JSON.stringify({ text: "done" }) },
      ]),
    ];
    let llmCalls = 0;
    const events: string[] = [];
    const loop = new AgentLoop({
      registry,
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      toolTransport: "native_tools",
      toolCallAdapter: null,
      llmComplete: async () => {
        const completion = script[llmCalls] ?? makeNativeCompletion();
        llmCalls += 1;
        return completion;
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      onEvent: (event) => {
        if (
          event.type === "empty_completion_recovered" ||
          event.type === "completion_truncated"
        )
          events.push(event.type);
      },
    });
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-empty-nt-trunc-reset", workingDir }),
      {
        userMessage: "go",
        maxSteps: 10,
        signal: new AbortController().signal,
      },
    );
    expect(events).toEqual([
      "empty_completion_recovered",
      "completion_truncated",
      "empty_completion_recovered",
    ]);
    expect(llmCalls).toBe(4);
    expect(result.reason).toBe("reply");
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
        if (event.type === "parse_failure_recovered")
          recoveries.push(event.attempt);
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
        makeCompletion(JSON.stringify({ tool: "does_not_exist", args: {} })),
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
        makeCompletion(toolCall("finish", { summary: "done" }), "gemma-4-it"),
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
      makeCompletion(toolCall("noop", {}), "qwen3-30b-a3b-instruct-2507"),
      // Step 1: server has been hot-swapped to Gemma. Reactive refresh
      // must pick it up before step 2 starts.
      makeCompletion(toolCall("noop", {}), "gemma-4-it"),
      // Step 2: close the turn so the loop doesn't stall.
      makeCompletion(toolCall("finish", { summary: "ok" }), "gemma-4-it"),
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
    reflectionRunner:
      | {
          reflect: (input: {
            sessionId: string;
            userMessage: string;
            assistantReply: string;
          }) => Promise<void>;
          abortPending: () => void;
        }
      | undefined,
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
