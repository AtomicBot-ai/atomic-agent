import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeStep } from "./step-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import {
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "../llm/model-profile.js";
import {
  REPAIR_MAX_TOKENS,
  TRIM_REFUSED_BY_FUSION_GATE,
  TRIM_REFUSED_BY_PLAN_MODE,
  detectFabricatedToolTranscript,
  formatFabricatedTranscriptNotice,
  type LlmStreamParams,
  trimBatchToFirstApprovalGated,
  turnPolicyForTrim,
  type StepApprovalPostureSource,
  type StepEvent,
} from "./step-executor.js";
import { OpenAiHttpError } from "../llm/provider/openai/openai-http.js";
import {
  buildGrammar,
  grammarToolNames,
} from "../llm/grammar/build-grammar.js";
import { createEmptySessionState } from "../session/session-state.js";
import {
  PLAIN_INSTRUCT_PROFILE as PLAIN_PROFILE_F31,
  QWEN_THINK_PROFILE as QWEN_PROFILE_F31,
} from "../llm/model-profile.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import { replyTool } from "../tools/conversation/reply.js";
import { resetConfigCache } from "../config/index.js";
import { buildOpenAiChatBody } from "../llm/provider/openai/openai-build-body.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
} from "../prompt/stable-prefix.js";
import type {
  CompletionResult,
  ToolCallTransport,
} from "../llm/provider/completion-types.js";

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

describe("executeStep rare tool autoload", () => {
  let grammarsDir: string;

  beforeEach(() => {
    grammarsDir = join(process.cwd(), "grammars");
  });

  it("injects loadedTools entry when a rare tool execution throws", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "os.git.show",
      description: "test",
      readonly: true,
      async run() {
        throw new Error("invalid args for test");
      },
    });
    registry.register({
      name: "reply",
      description: "reply",
      readonly: true,
      async run(args: Record<string, unknown>) {
        return compressToolResult({
          tool: "reply",
          status: "ok",
          output: String(args.text ?? ""),
        });
      },
    });

    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const session = createEmptySessionState({ id: "s-auto", workingDir: "/w" });
    const completionBody = JSON.stringify({
      tool: "os.git.show",
      args: { revision: "HEAD" },
    });

    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async () => ({
          content: completionBody,
          reasoningContent: "",
          stop: true,
          truncated: false,
          timing: {
            promptMs: 1,
            predictedMs: 1,
            promptTokens: 20,
            predictedTokens: 5,
          },
          cacheHitTokens: 0,
          slotId: 0,
          modelId: "mock",
        }),
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
      },
    );

    expect(outcome.toolResults).toHaveLength(1);
    expect(outcome.toolResults[0]!.status).toBe("error");
    const names = outcome.nextSession.loadedTools.map((t) => t.name);
    expect(names).toContain("os.git.show");
    expect(
      outcome.nextSession.loadedTools.find((t) => t.name === "os.git.show")
        ?.source,
    ).toBe("auto");
  });
});

describe("executeStep batch handling", () => {
  let grammarsDir: string;

  beforeEach(() => {
    grammarsDir = join(process.cwd(), "grammars");
  });

  function makeRegistry() {
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "read",
      readonly: true,
      async run(args) {
        return compressToolResult({
          tool: "os.fs.read",
          status: "ok",
          output: `read ${args.path}`,
        });
      },
    });
    registry.register({
      name: "os.fs.write",
      description: "write",
      readonly: false,
      async run(args) {
        return compressToolResult({
          tool: "os.fs.write",
          status: "ok",
          output: `wrote ${args.path}`,
        });
      },
    });
    registry.register({
      name: "os.fs.edit",
      description: "edit",
      readonly: false,
      async run(args) {
        return compressToolResult({
          tool: "os.fs.edit",
          status: "ok",
          output: `edited ${args.path}`,
        });
      },
    });
    registry.register({
      name: "reply",
      description: "reply",
      readonly: true,
      async run(args) {
        return compressToolResult({
          tool: "reply",
          status: "ok",
          output: String(args.text ?? ""),
        });
      },
    });
    return registry;
  }

  async function runWithBody(body: string) {
    const registry = makeRegistry();
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const session = createEmptySessionState({
      id: "s-batch",
      workingDir: "/w",
    });
    return executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async () => ({
          content: body,
          reasoningContent: "",
          stop: true,
          truncated: false,
          timing: {
            promptMs: 1,
            predictedMs: 1,
            promptTokens: 20,
            predictedTokens: 5,
          },
          cacheHitTokens: 0,
          slotId: 0,
          modelId: "mock",
        }),
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
      },
    );
  }

  it("executes a 3-call read batch and returns aligned arrays", async () => {
    const body = JSON.stringify([
      { tool: "os.fs.read", args: { path: "a" } },
      { tool: "os.fs.read", args: { path: "b" } },
      { tool: "os.fs.read", args: { path: "c" } },
    ]);
    const outcome = await runWithBody(body);
    expect(outcome.toolCalls).toHaveLength(3);
    expect(outcome.toolResults).toHaveLength(3);
    expect(outcome.toolResults.every((r) => r.status === "ok")).toBe(true);
    expect(outcome.toolResults.map((r) => r.summary)).toEqual([
      "read a",
      "read b",
      "read c",
    ]);
    expect(outcome.terminal).toBeNull();
  });

  it("rejects a batch with a terminal verb NOT at the last position", async () => {
    // `reply` at index 0 of a 2-call batch is invalid: the runtime
    // cannot keep firing tools after the turn has been closed. Same
    // body returned twice — both attempts fail validation, so the
    // executor surfaces the error as a GrammarError after the
    // one-shot retry.
    const body = JSON.stringify([
      { tool: "reply", args: { text: "done" } },
      { tool: "os.fs.read", args: { path: "a" } },
    ]);
    await expect(runWithBody(body)).rejects.toThrow(
      /terminal verb 'reply' must be the last call in a batch/,
    );
  });

  it("executes a [tool, reply] tail-terminal batch in one inference", async () => {
    // Validator allows `reply` as the last call of a batch; executor
    // runs the read first, then the reply solo (terminal-tail
    // barrier). Outcome is identical to a `reply`-only solo step:
    // `terminal === "turn"` so the agent loop closes the turn.
    const body = JSON.stringify([
      { tool: "os.fs.read", args: { path: "a" } },
      { tool: "reply", args: { text: "all done" } },
    ]);
    const outcome = await runWithBody(body);
    expect(outcome.toolCalls).toHaveLength(2);
    expect(outcome.toolCalls.map((c) => c.tool)).toEqual([
      "os.fs.read",
      "reply",
    ]);
    expect(outcome.toolResults).toHaveLength(2);
    expect(outcome.toolResults[0]!.summary).toBe("read a");
    expect(outcome.toolResults[1]!.status).toBe("ok");
    expect(outcome.terminal).toBe("turn");
    // Transcript: read's tool_call + tool_result pair, then a single
    // assistant_reply that collapses the terminal call.
    const turns = outcome.nextSession.turns;
    const tail = turns.slice(-3);
    expect(tail.map((t) => t.kind)).toEqual([
      "assistant_tool_call",
      "tool_result",
      "assistant_reply",
    ]);
  });

  it("native_tools: unparseable reasoning-only completion routes through parse_retry, never leaks CoT as a reply", async () => {
    // `reasoning_content` is internal scratch space by OpenAI-compatible
    // convention. An earlier salvage path wrapped an unparseable
    // reasoning body verbatim into `reply { text }` — raw chain-of-
    // thought delivered as deliberate agent speech (issue #285). The
    // executor must instead treat it like any other unparseable body:
    // one `parse_retry` through the repair prompt, and the repaired
    // completion's answer — never the reasoning text — reaches the user.
    const registry = makeRegistry();
    const session = createEmptySessionState({
      id: "s-native-reasoning-only",
      workingDir: "/w",
    });
    const events: Array<{ type: string }> = [];
    const cot =
      "The user asked whether reasoning tokens leak. I should inspect the binary...";
    let llmCalls = 0;

    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "привет",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        async llmComplete() {
          llmCalls += 1;
          if (llmCalls === 1) {
            return {
              content: "",
              reasoningContent: cot,
              stop: true,
              truncated: false,
              timing: {
                promptMs: 1,
                predictedMs: 1,
                promptTokens: 20,
                predictedTokens: 5,
              },
              cacheHitTokens: 0,
              slotId: -1,
              modelId: "openai/gpt-5.5",
            };
          }
          return {
            content: "",
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: 5,
            },
            cacheHitTokens: 0,
            slotId: -1,
            modelId: "openai/gpt-5.5",
            toolCalls: [
              {
                id: "call-repair",
                type: "function",
                function: {
                  name: "reply",
                  arguments: JSON.stringify({ text: "Привет!" }),
                },
              },
            ],
          };
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
        onEvent(event) {
          events.push({ type: event.type });
        },
      },
    );

    expect(llmCalls).toBe(2);
    expect(events.some((event) => event.type === "parse_retry")).toBe(true);
    expect(outcome.toolResults).toHaveLength(1);
    expect(outcome.toolResults[0]?.status).toBe("ok");
    expect(outcome.nextSession.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "Привет!",
    });
    // The leak itself: no reply anywhere in the transcript may carry the
    // raw reasoning body.
    for (const turn of outcome.nextSession.turns) {
      if (turn.kind === "assistant_reply") {
        expect(turn.text).not.toContain(cot);
      }
    }
    expect(
      outcome.toolCalls.some(
        (call) =>
          call.tool === "reply" &&
          typeof call.args?.text === "string" &&
          call.args.text.includes(cot),
      ),
    ).toBe(false);
  });

  it("native_tools: recovers a GBNF-shaped batch embedded in `reasoning_content` without a retry", async () => {
    // Reasoning models sometimes emit the persona's `[{tool, args}]`
    // array inside the think channel and end the turn with `content`
    // empty. That is a real tool-call emission, not scratch space — the
    // parser must recover it in place (no repair round-trip).
    const registry = makeRegistry();
    const session = createEmptySessionState({
      id: "s-native-gbnf-in-reasoning",
      workingDir: "/w",
    });
    const events: Array<{ type: string }> = [];
    let llmCalls = 0;

    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "привет",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        async llmComplete() {
          llmCalls += 1;
          return {
            content: "",
            reasoningContent:
              '[{"tool":"reply","args":{"text":"Привет, инициат!"}}]',
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: 12,
            },
            cacheHitTokens: 0,
            slotId: -1,
            modelId: "z-ai/glm-5.3-flash",
          };
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
        onEvent(event) {
          events.push({ type: event.type });
        },
      },
    );

    expect(llmCalls).toBe(1);
    expect(events.some((event) => event.type === "parse_retry")).toBe(false);
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]).toMatchObject({
      tool: "reply",
      args: { text: "Привет, инициат!" },
    });
    expect(outcome.nextSession.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "Привет, инициат!",
    });
  });

  it("native_tools: reasoning-only on both attempts surfaces a parse error, not the CoT", async () => {
    // Twice-unparseable reasoning ends the step as a GrammarError. Before
    // issue #285 the first attempt already "succeeded" by leaking the
    // reasoning body as the reply, so this path was unreachable.
    const registry = makeRegistry();
    const session = createEmptySessionState({
      id: "s-native-reasoning-twice",
      workingDir: "/w",
    });
    const events: Array<{ type: string }> = [];
    let llmCalls = 0;

    await expect(
      executeStep(
        {
          session,
          toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
          capabilities: CAPS,
          skillCatalog: SKILLS,
          stepIndex: 0,
          signal: new AbortController().signal,
          userMessage: "привет",
        },
        {
          registry,
          slotManager: new SlotManager(2),
          async llmComplete() {
            llmCalls += 1;
            return {
              content: "",
              reasoningContent: "Hmm, let me think about the binary layout...",
              stop: true,
              truncated: false,
              timing: {
                promptMs: 1,
                predictedMs: 1,
                promptTokens: 20,
                predictedTokens: 5,
              },
              cacheHitTokens: 0,
              slotId: -1,
              modelId: "z-ai/glm-5.3-flash",
            };
          },
          grammar: "",
          profile: PLAIN_INSTRUCT_PROFILE,
          toolTransport: "native_tools",
          toolCallAdapter: null,
          supportsSlotAffinity: false,
          onEvent(event) {
            events.push({ type: event.type });
          },
        },
      ),
    ).rejects.toMatchObject({ name: "GrammarError" });

    expect(llmCalls).toBe(2);
    expect(events.some((event) => event.type === "parse_retry")).toBe(true);
  });

  it("native_tools: the repair prompt mandates native function-calling, never a corrected JSON array", async () => {
    // The repair replays with the SAME llmParams as the failed attempt —
    // under `native_tools` that request carries the OpenAI `tools`
    // payload and a stable prefix that forbids text-JSON emission.
    // Appending the grammar repair mandate ("Emit a corrected JSON array
    // only", "Use a length-1 array") onto that prefix re-creates the
    // issue #285 dual mandate at the one retry a failing model gets
    // before GrammarError kills the step.
    const registry = makeRegistry();
    const session = createEmptySessionState({
      id: "s-native-repair-prompt",
      workingDir: "/w",
    });
    const prompts: string[] = [];
    let llmCalls = 0;

    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "привет",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        async llmComplete({ prompt }) {
          prompts.push(prompt);
          llmCalls += 1;
          if (llmCalls === 1) {
            // Reasoning-only completion: unparseable, routes through the
            // one-shot repair (the exact path issue #285 redirected).
            return {
              content: "",
              reasoningContent: "Let me think about what to do here...",
              stop: true,
              truncated: false,
              timing: {
                promptMs: 1,
                predictedMs: 1,
                promptTokens: 20,
                predictedTokens: 5,
              },
              cacheHitTokens: 0,
              slotId: -1,
              modelId: "openai/gpt-5.5",
            };
          }
          return {
            content: "",
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: 5,
            },
            cacheHitTokens: 0,
            slotId: -1,
            modelId: "openai/gpt-5.5",
            toolCalls: [
              {
                id: "call-repaired",
                type: "function",
                function: {
                  name: "reply",
                  arguments: JSON.stringify({ text: "готово" }),
                },
              },
            ],
          };
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
      },
    );

    expect(outcome.terminal).toBe("turn");
    expect(prompts).toHaveLength(2);
    const repairPrompt = prompts[1]!;
    expect(repairPrompt).toContain("### tool-call-repair");
    // Native corrective mandate present...
    expect(repairPrompt).toContain("native function-calling interface");
    expect(repairPrompt).toContain("do NOT write tool-call JSON as text");
    // ...and no trace of the text-array mandate anywhere in the repair
    // prompt (stable prefix included).
    expect(repairPrompt).not.toContain("Emit a corrected JSON array");
    expect(repairPrompt).not.toContain("Use a length-1 array");
    expect(repairPrompt).not.toContain("Emit a JSON ARRAY of tool calls now");
    expect(repairPrompt).not.toContain("length-1 array");
    expect(repairPrompt).not.toContain("One tool-call array per step");
  });

  it("repairs a native-tools reply call with empty args before execution", async () => {
    const registry = makeRegistry();
    const session = createEmptySessionState({
      id: "s-native-empty-reply",
      workingDir: "/w",
    });
    const events: Array<{ type: string }> = [];
    const calls: unknown[] = [];

    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "привет",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        async llmComplete(params) {
          calls.push(params);
          return {
            content: "",
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: 5,
            },
            cacheHitTokens: 0,
            slotId: -1,
            modelId: "openai/gpt-5.5",
            toolCalls: [
              {
                id: `call-${calls.length}`,
                type: "function",
                function: {
                  name: "reply",
                  arguments:
                    calls.length === 1
                      ? "{}"
                      : JSON.stringify({ text: "Привет!" }),
                },
              },
            ],
          };
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
        onEvent(event) {
          events.push({ type: event.type });
        },
      },
    );

    expect(calls).toHaveLength(2);
    expect(events.some((event) => event.type === "parse_retry")).toBe(true);
    expect(outcome.toolResults).toHaveLength(1);
    expect(outcome.toolResults[0]?.status).toBe("ok");
    expect(outcome.nextSession.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "Привет!",
    });
  });

  it("native_tools: synthesises a reply from plain content when the model returned no tool_calls", async () => {
    // Companion of `tool_choice: "auto"` (set in `buildLlmStreamParams`).
    // When a cloud model (Qwen-thinking, GLM, OpenAI in `auto` mode) chooses
    // to answer in plain text instead of wrapping the answer in a `reply`
    // tool call, the executor must turn `completion.content` into a
    // length-1 `[{tool:"reply", args:{text}}]` batch so the
    // one-inference-per-step contract holds and the user sees the reply.
    const registry = makeRegistry();
    const session = createEmptySessionState({
      id: "s-native-synth",
      workingDir: "/w",
    });
    const events: Array<{ type: string }> = [];
    let llmCalls = 0;

    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "привет",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        async llmComplete() {
          llmCalls += 1;
          return {
            content: "Привет, магос!",
            reasoningContent: "user greeted me, answering in kind",
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: 5,
            },
            cacheHitTokens: 0,
            slotId: -1,
            modelId: "qwen/qwen3.7-max",
          };
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
        onEvent(event) {
          events.push({ type: event.type });
        },
      },
    );

    expect(llmCalls).toBe(1);
    expect(events.some((event) => event.type === "parse_retry")).toBe(false);
    expect(outcome.terminal).toBe("turn");
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]).toMatchObject({
      tool: "reply",
      args: { text: "Привет, магос!" },
      // Reasoning carries through to the synthesised call so the rest of
      // the trace recorder / step pipeline observes it the same way it
      // would for a model-emitted tool_call.
      reasoning: "user greeted me, answering in kind",
    });
    expect(outcome.nextSession.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "Привет, магос!",
    });
  });

  it("native_tools: recovers a GBNF-shaped JSON array emitted in `content` instead of `tool_calls`", async () => {
    // Cloud models (GPT-5 via aimlapi, GLM-5 via openrouter) sometimes
    // follow the persona's "emit [{tool, args}, ...] JSON array"
    // instruction literally and put the array in `content` while
    // leaving `tool_calls` empty. Before this fix the runtime would
    // wrap the whole JSON literal into `reply { text: <raw JSON> }`,
    // so the user saw `[{"tool":"reply","args":{"text":"..."}}]` in
    // their chat. The recovery path must parse `content` as a GBNF
    // batch first and fall back to the reply-wrap only when parsing
    // fails.
    const registry = makeRegistry();
    const session = createEmptySessionState({
      id: "s-native-gbnf-in-content",
      workingDir: "/w",
    });
    const events: Array<{ type: string }> = [];
    let llmCalls = 0;

    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "привет",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        async llmComplete() {
          llmCalls += 1;
          return {
            content: '[{"tool":"reply","args":{"text":"Привет, инициат!"}}]',
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: 12,
            },
            cacheHitTokens: 0,
            slotId: -1,
            modelId: "openai/gpt-5-2",
          };
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
        onEvent(event) {
          events.push({ type: event.type });
        },
      },
    );

    expect(llmCalls).toBe(1);
    expect(events.some((event) => event.type === "parse_retry")).toBe(false);
    expect(outcome.terminal).toBe("turn");
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]).toMatchObject({
      tool: "reply",
      args: { text: "Привет, инициат!" },
    });
    expect(outcome.nextSession.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "Привет, инициат!",
    });
  });

  it("native_tools: un-escapes `__` tool names emitted in a GBNF-shaped `content` array", async () => {
    // When a cloud model emits the tool call as text in `content` (instead
    // of the structured `tool_calls` envelope) it copies the *escaped*
    // function name from the OpenAI `tools` schema, e.g. `os__fs__read`.
    // The recovery parser must un-escape it back to the dotted registry id
    // `os.fs.read` — otherwise `registry.has(...)` rejects the call with
    // `tool not registered in this agent: os__fs__read`.
    const registry = makeRegistry();
    const session = createEmptySessionState({
      id: "s-native-escaped-name",
      workingDir: "/w",
    });
    let llmCalls = 0;

    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "read it",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        async llmComplete() {
          llmCalls += 1;
          return {
            content: '[{"tool":"os__fs__read","args":{"path":"/w/a"}}]',
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: 12,
            },
            cacheHitTokens: 0,
            slotId: -1,
            modelId: "openai/gpt-5-2",
          };
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
      },
    );

    expect(llmCalls).toBe(1);
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]).toMatchObject({
      tool: "os.fs.read",
      args: { path: "/w/a" },
    });
    expect(outcome.toolResults[0]!.status).toBe("ok");
  });

  it("native_tools: routes 'no tool_calls and no content' through ModelError, not parse_retry", async () => {
    // A truly empty completion (no tool_calls + no content) has nothing
    // for the synthesis branch to recover from, and replaying the same
    // prompt would reproduce the same empty wall. The executor must
    // surface this as a ModelError (category `model`) so the agent loop
    // fails fast instead of burning a parse-retry cycle on it.
    const registry = makeRegistry();
    const session = createEmptySessionState({
      id: "s-native-empty",
      workingDir: "/w",
    });

    await expect(
      executeStep(
        {
          session,
          toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
          capabilities: CAPS,
          skillCatalog: SKILLS,
          stepIndex: 0,
          signal: new AbortController().signal,
          userMessage: "привет",
        },
        {
          registry,
          slotManager: new SlotManager(2),
          async llmComplete() {
            return {
              content: "",
              reasoningContent: "",
              stop: true,
              truncated: false,
              timing: {
                promptMs: 1,
                predictedMs: 1,
                promptTokens: 20,
                predictedTokens: 0,
              },
              cacheHitTokens: 0,
              slotId: -1,
              modelId: "openai/gpt-5.5",
            };
          },
          grammar: "",
          profile: PLAIN_INSTRUCT_PROFILE,
          toolTransport: "native_tools",
          toolCallAdapter: null,
          supportsSlotAffinity: false,
        },
      ),
    ).rejects.toMatchObject({ name: "ModelError" });
  });

  // Note: the "tail reply fires even when an earlier non-terminal
  // call errored" invariant is pinned directly on the executor in
  // src/agent/batch-executor.test.ts — no need to duplicate it here
  // via a thrown registry tool (which would surface as
  // ToolExecutionError before the batch even runs).

  it("uses a structured repair prompt for validation retry", async () => {
    const registry = makeRegistry();
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const session = createEmptySessionState({
      id: "s-repair",
      workingDir: "/w",
    });
    const prompts: string[] = [];
    // Mid-batch terminal: invalid (`reply` must be last); the model is
    // asked to re-emit. The repair attempt returns a clean solo reply.
    const bodies = [
      JSON.stringify([
        { tool: "reply", args: { text: "done" } },
        { tool: "os.fs.read", args: { path: "a" } },
      ]),
      JSON.stringify({ tool: "reply", args: { text: "done" } }),
    ];
    let calls = 0;
    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async ({ prompt }) => {
          prompts.push(prompt);
          const content = bodies[calls] ?? bodies[bodies.length - 1]!;
          calls += 1;
          return {
            content,
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: 5,
            },
            cacheHitTokens: 0,
            slotId: 0,
            modelId: "mock",
          };
        },
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
      },
    );
    expect(outcome.terminal).toBe("turn");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("### tool-call-repair");
    expect(prompts[1]).toContain(
      "terminal verb 'reply' must be the last call in a batch",
    );
    expect(prompts[1]).toContain("Use a length-1 array");
  });

  it(
    "for thinking profiles strips and re-appends the <think> open tag, " +
      "and caps the repair completion at REPAIR_MAX_TOKENS",
    async () => {
      const registry = makeRegistry();
      const grammar = await buildGrammar(QWEN_THINK_PROFILE, grammarsDir);
      const session = createEmptySessionState({
        id: "s-repair-think",
        workingDir: "/w",
      });
      const prompts: string[] = [];
      const maxTokensSeen: Array<number | undefined> = [];
      // Bodies are what llama-server returns AFTER the appended
      // `<think>` prefill; the executor's normalizeContent prepends
      // the prefix back, so we close the think-block immediately and
      // emit the JSON body. The repair attempt has the same shape:
      // prompt ends with `<think>` (re-appended after strip), model
      // closes it and emits JSON.
      // Mid-batch terminal: invalid (`reply` must be last); the model
      // recovers with a clean solo reply on the repair attempt.
      const bodies = [
        `</think>${JSON.stringify([
          { tool: "reply", args: { text: "done" } },
          { tool: "os.fs.read", args: { path: "a" } },
        ])}`,
        `</think>${JSON.stringify({ tool: "reply", args: { text: "done" } })}`,
      ];
      let calls = 0;
      const outcome = await executeStep(
        {
          session,
          toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
          capabilities: CAPS,
          skillCatalog: SKILLS,
          stepIndex: 0,
          signal: new AbortController().signal,
          userMessage: "x",
        },
        {
          registry,
          slotManager: new SlotManager(2),
          llmComplete: async ({ prompt, maxTokens }) => {
            prompts.push(prompt);
            maxTokensSeen.push(maxTokens);
            const content = bodies[calls] ?? bodies[bodies.length - 1]!;
            calls += 1;
            return {
              content,
              reasoningContent: "",
              stop: true,
              truncated: false,
              timing: {
                promptMs: 1,
                predictedMs: 1,
                promptTokens: 20,
                predictedTokens: 5,
              },
              cacheHitTokens: 0,
              slotId: 0,
              modelId: "mock",
            };
          },
          grammar,
          profile: QWEN_THINK_PROFILE,
        },
      );

      expect(outcome.terminal).toBe("turn");
      expect(prompts).toHaveLength(2);

      // First call: standard prompt — buildPrompt appends the `<think>`
      // prefill at the very end so qwen-think starts in reasoning mode.
      expect(prompts[0]!.trimEnd().endsWith("<think>")).toBe(true);

      // Repair call: the trailing `<think>` must be stripped (otherwise
      // the repair instructions would land INSIDE the open think-block
      // and the model would loop on self-deliberation), then re-appended
      // at the very end so the model continues in its normal think →
      // `</think>` → JSON flow (bounded by `REPAIR_MAX_TOKENS`).
      const repairPrompt = prompts[1]!;
      expect(repairPrompt).toContain("### tool-call-repair");
      expect(repairPrompt.trimEnd().endsWith("<think>")).toBe(true);
      // The repair body must contain exactly one `<think>` open tag
      // (the trailing one) and no closing `</think>` — the model emits
      // the close marker itself in its response.
      const openTagOccurrences = repairPrompt.match(/<think>/g) ?? [];
      expect(openTagOccurrences.length).toBe(1);
      expect(repairPrompt).not.toContain("</think>");

      // Hard cap on the repair completion (defends against runaway
      // reasoning loops on the structured-repair path).
      expect(maxTokensSeen[0]).toBeUndefined();
      expect(maxTokensSeen[1]).toBe(REPAIR_MAX_TOKENS);
      expect(REPAIR_MAX_TOKENS).toBeLessThanOrEqual(1024);
    },
  );

  it(
    "auto-trims a batch containing an approval-gated verb to a length-1 " +
      "execution (no LLM repair round-trip, no parse_retry)",
    async () => {
      // Mirrors the production `coding-extract-shared-constant` trace
      // pattern: model emits [write, edit, edit] expecting parallel
      // execution. The runtime cannot batch approval-gated tools, so
      // the trim path executes the first approval-gated call (write)
      // and surfaces a `### notice` for the next step listing the
      // dropped tools so the model can retry them one-by-one.
      const body = JSON.stringify([
        {
          tool: "os.fs.write",
          args: { path: "src/constants.ts", content: "x" },
        },
        {
          tool: "os.fs.edit",
          args: { path: "src/a.ts", oldString: "x", newString: "y" },
        },
        {
          tool: "os.fs.edit",
          args: { path: "src/b.ts", oldString: "x", newString: "y" },
        },
      ]);
      const events: Array<{ type: string; reason?: string; kept?: string }> =
        [];
      const registry = makeRegistry();
      const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
      const session = createEmptySessionState({
        id: "s-trim",
        workingDir: "/w",
      });
      const outcome = await executeStep(
        {
          session,
          toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
          capabilities: CAPS,
          skillCatalog: SKILLS,
          stepIndex: 0,
          signal: new AbortController().signal,
          userMessage: "x",
        },
        {
          registry,
          slotManager: new SlotManager(2),
          llmComplete: async () => ({
            content: body,
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: 5,
            },
            cacheHitTokens: 0,
            slotId: 0,
            modelId: "mock",
          }),
          grammar,
          profile: PLAIN_INSTRUCT_PROFILE,
          onEvent: (ev) => {
            if (ev.type === "batch_trimmed" || ev.type === "parse_retry") {
              events.push({
                type: ev.type,
                ...(ev.type === "batch_trimmed"
                  ? { kept: ev.kept, reason: ev.reason }
                  : { reason: ev.reason }),
              });
            }
          },
        },
      );

      // Only the first approval-gated call executes; the other two are
      // dropped without invoking the registry.
      expect(outcome.toolCalls).toHaveLength(1);
      expect(outcome.toolResults).toHaveLength(1);
      expect(outcome.toolCalls[0]!.tool).toBe("os.fs.write");
      expect(outcome.toolResults[0]!.status).toBe("ok");
      expect(outcome.toolResults[0]!.summary).toBe("wrote src/constants.ts");

      // A `batch_trimmed` event fires in place of `parse_retry` — no
      // second LLM call happened on the trim path.
      const trims = events.filter((e) => e.type === "batch_trimmed");
      const retries = events.filter((e) => e.type === "parse_retry");
      expect(trims).toHaveLength(1);
      expect(retries).toHaveLength(0);
      expect(trims[0]!.kept).toBe("os.fs.write");
      expect(trims[0]!.reason).toBe("approval-gated-batched");

      // Trim notice text is captured on the outcome so the agent loop
      // can plumb it into the next step's `transientNotice`.
      expect(outcome.trimmedBatchNotice).toBeDefined();
      expect(outcome.trimmedBatchNotice).toContain("os.fs.write");
      expect(outcome.trimmedBatchNotice).toContain("os.fs.edit");
      expect(outcome.trimmedBatchNotice).toContain("length-1 array");
    },
  );

  it(
    "still routes a batch with a mid-position terminal verb through the " +
      "LLM repair path (mid-batch terminals are not trim-eligible)",
    async () => {
      // `[reply, read]` puts the terminal verb at index 0 — invalid by
      // the new tail-only rule. The trim shortcut only fires for
      // approval-gated-only failures; a misplaced terminal goes
      // through repair. Both attempts return the same offending body,
      // surfacing the legacy GrammarError after the one-shot repair.
      const body = JSON.stringify([
        { tool: "reply", args: { text: "done" } },
        { tool: "os.fs.read", args: { path: "a" } },
      ]);
      await expect(runWithBody(body)).rejects.toThrow(
        /terminal verb 'reply' must be the last call in a batch/,
      );
    },
  );

  it("trims an approval-gated call even when it is not the first in the batch", async () => {
    // Model batches [read, edit]: the read is `pure_read` (batchable)
    // but the edit is approval-gated, so the validator rejects the
    // whole batch. Trim keeps the edit (the first approval-gated
    // call), drops the read, and surfaces the read in the notice so
    // the model can re-emit it next step if it still wants it.
    const body = JSON.stringify([
      { tool: "os.fs.read", args: { path: "src/a.ts" } },
      {
        tool: "os.fs.edit",
        args: { path: "src/a.ts", oldString: "x", newString: "y" },
      },
    ]);
    const outcome = await runWithBody(body);
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]!.tool).toBe("os.fs.edit");
    expect(outcome.trimmedBatchNotice).toContain("os.fs.read");
  });

  it("emits one tool_call_parsed and tool_call_executed per call with batchIndex", async () => {
    const body = JSON.stringify([
      { tool: "os.fs.read", args: { path: "a" } },
      { tool: "os.fs.read", args: { path: "b" } },
    ]);
    const events: Array<{
      type: string;
      batchIndex?: number;
      batchSize?: number;
    }> = [];
    const registry = makeRegistry();
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const session = createEmptySessionState({ id: "s-ev", workingDir: "/w" });
    await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async () => ({
          content: body,
          reasoningContent: "",
          stop: true,
          truncated: false,
          timing: {
            promptMs: 1,
            predictedMs: 1,
            promptTokens: 20,
            predictedTokens: 5,
          },
          cacheHitTokens: 0,
          slotId: 0,
          modelId: "mock",
        }),
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
        onEvent: (ev) => {
          if (
            ev.type === "tool_call_parsed" ||
            ev.type === "tool_call_executed"
          ) {
            events.push({
              type: ev.type,
              batchIndex: ev.batchIndex,
              batchSize: ev.batchSize,
            });
          }
        },
      },
    );
    const parsed = events.filter((e) => e.type === "tool_call_parsed");
    const executed = events.filter((e) => e.type === "tool_call_executed");
    expect(parsed).toHaveLength(2);
    expect(executed).toHaveLength(2);
    expect(parsed.map((e) => e.batchIndex).sort()).toEqual([0, 1]);
    expect(parsed.every((e) => e.batchSize === 2)).toBe(true);
    expect(executed.every((e) => e.batchSize === 2)).toBe(true);
  });

  it("appends N call/result pairs to the conversation in batch-index order", async () => {
    const body = JSON.stringify([
      { tool: "os.fs.read", args: { path: "a" } },
      { tool: "os.fs.read", args: { path: "b" } },
    ]);
    const outcome = await runWithBody(body);
    const turns = outcome.nextSession.turns;
    // Last 4 turns: call0, result0, call1, result1.
    const tail = turns.slice(-4);
    expect(tail.map((t) => t.kind)).toEqual([
      "assistant_tool_call",
      "tool_result",
      "assistant_tool_call",
      "tool_result",
    ]);
    expect((tail[1] as { summary: string }).summary).toBe("read a");
    expect((tail[3] as { summary: string }).summary).toBe("read b");
  });

  it("does not collect a per-failed-rare autoload for successful batches", async () => {
    const body = JSON.stringify([
      { tool: "os.fs.read", args: { path: "a" } },
      { tool: "os.fs.read", args: { path: "b" } },
    ]);
    const outcome = await runWithBody(body);
    expect(outcome.nextSession.loadedTools).toEqual([]);
  });

  it("preserves single-call legacy shape when model emits a plain object", async () => {
    const body = JSON.stringify({
      tool: "os.fs.read",
      args: { path: "only" },
    });
    const outcome = await runWithBody(body);
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolResults).toHaveLength(1);
    expect(outcome.toolResults[0]!.summary).toBe("read only");
    expect(outcome.terminal).toBeNull();
  });

  it("treats a single-element array as solo (terminal verb allowed)", async () => {
    const body = JSON.stringify([
      { tool: "reply", args: { text: "all done" } },
    ]);
    const outcome = await runWithBody(body);
    expect(outcome.terminal).toBe("turn");
  });
});

describe("executeStep pure-read wave splitting (#111)", () => {
  let grammarsDir: string;

  beforeEach(() => {
    grammarsDir = join(process.cwd(), "grammars");
  });

  // `makeRegistry` in the batch-handling describe is lexically scoped
  // there; this describe needs its own registry with the same tools.
  function makeRegistry() {
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "read",
      readonly: true,
      async run(args) {
        return compressToolResult({
          tool: "os.fs.read",
          status: "ok",
          output: `read ${args.path}`,
        });
      },
    });
    registry.register({
      name: "os.fs.write",
      description: "write",
      readonly: false,
      async run(args) {
        return compressToolResult({
          tool: "os.fs.write",
          status: "ok",
          output: `wrote ${args.path}`,
        });
      },
    });
    registry.register({
      name: "os.fs.edit",
      description: "edit",
      readonly: false,
      async run(args) {
        return compressToolResult({
          tool: "os.fs.edit",
          status: "ok",
          output: `edited ${args.path}`,
        });
      },
    });
    registry.register({
      name: "reply",
      description: "reply",
      readonly: true,
      async run(args) {
        return compressToolResult({
          tool: "reply",
          status: "ok",
          output: String(args.text ?? ""),
        });
      },
    });
    return registry;
  }

  // Default cap is 8 (ENV_DEFAULTS.MAX_PARALLEL_TOOL_CALLS). 14 reads
  // is the issue's canonical oversized case → waves of 8 and 6.
  function reads(
    n: number,
  ): Array<{ tool: string; args: Record<string, unknown> }> {
    return Array.from({ length: n }, (_, i) => ({
      tool: "os.fs.read",
      args: { path: `f${i}` },
    }));
  }

  async function runWithBody(
    body: string,
    opts?: {
      envCap?: number;
      repairBody?: string;
      extraRegistry?: (reg: ToolRegistry) => void;
    },
  ) {
    const registry = makeRegistry();
    opts?.extraRegistry?.(registry);
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const session = createEmptySessionState({ id: "s-wave", workingDir: "/w" });
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    let llmCalls = 0;
    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async () => {
          llmCalls += 1;
          return {
            content: llmCalls > 1 && opts?.repairBody ? opts.repairBody : body,
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: 5,
            },
            cacheHitTokens: 0,
            slotId: 0,
            modelId: "mock",
          };
        },
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
        onEvent: (ev) => {
          if (
            ev.type === "batch_wave_split" ||
            ev.type === "parse_retry" ||
            ev.type === "batch_trimmed"
          ) {
            events.push(ev as { type: string; [k: string]: unknown });
          }
        },
      },
    );
    return { outcome, events, llmCalls };
  }

  it("wave-splits a 14-read oversized pure-read batch without an LLM repair", async () => {
    const { outcome, events, llmCalls } = await runWithBody(
      JSON.stringify(reads(14)),
    );
    // All 14 executed, correlated by original batch index.
    expect(outcome.toolCalls).toHaveLength(14);
    expect(outcome.toolResults).toHaveLength(14);
    expect(outcome.toolResults.map((r) => r.summary)).toEqual(
      Array.from({ length: 14 }, (_, i) => `read f${i}`),
    );
    // One `batch_wave_split` event with the full plan; no repair.
    const waves = events.filter((e) => e.type === "batch_wave_split");
    const retries = events.filter((e) => e.type === "parse_retry");
    expect(waves).toHaveLength(1);
    expect(retries).toHaveLength(0);
    expect(llmCalls).toBe(1);
    expect(waves[0]).toMatchObject({
      originalSize: 14,
      cap: 8,
      waveCount: 2,
      boundaries: [0, 8],
    });
  });

  it("executes an exact-cap batch in a single wave (no split, no repair)", async () => {
    const { outcome, events, llmCalls } = await runWithBody(
      JSON.stringify(reads(8)),
    );
    expect(outcome.toolResults).toHaveLength(8);
    expect(llmCalls).toBe(1);
    expect(events.filter((e) => e.type === "batch_wave_split")).toHaveLength(0);
    expect(events.filter((e) => e.type === "parse_retry")).toHaveLength(0);
  });

  it("wave-splits into 14 single-call waves when the cap is 1", async () => {
    process.env.ATOMIC_AGENT_MAX_PARALLEL_TOOL_CALLS = "1";
    resetConfigCache();
    try {
      const { outcome, events, llmCalls } = await runWithBody(
        JSON.stringify(reads(14)),
      );
      expect(outcome.toolResults).toHaveLength(14);
      expect(llmCalls).toBe(1);
      const waves = events.filter((e) => e.type === "batch_wave_split");
      expect(waves).toHaveLength(1);
      expect(waves[0]).toMatchObject({
        originalSize: 14,
        cap: 1,
        waveCount: 14,
        boundaries: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      });
    } finally {
      delete process.env.ATOMIC_AGENT_MAX_PARALLEL_TOOL_CALLS;
      resetConfigCache();
    }
  });

  it("routes a schema-invalid oversized pure-read batch to repair (no wave split)", async () => {
    // One read carries args that fail the `os.fs.read` JSON schema
    // (`path` is required and must be a string). The batch is not
    // wave-splittable — preflight fails — so it goes through repair.
    const calls = reads(13);
    calls.push({ tool: "os.fs.read", args: { path: 123 } });
    const { outcome, events, llmCalls } = await runWithBody(
      JSON.stringify(calls),
      { repairBody: JSON.stringify(reads(1)) },
    );
    expect(events.filter((e) => e.type === "batch_wave_split")).toHaveLength(0);
    expect(events.filter((e) => e.type === "parse_retry")).toHaveLength(1);
    expect(llmCalls).toBe(2);
    // The repaired response ran; the original 14 never dispatched.
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolResults[0]!.summary).toBe("read f0");
  });

  it("routes an oversized [approval_gated, pure_read, ...] batch to repair, bypassing approval trim", async () => {
    // Explicit issue case: an oversized batch whose first call is
    // approval-gated must bypass BOTH wave splitting AND approval
    // trimming — parse_retry, no original call dispatched.
    const calls = [
      { tool: "os.fs.write", args: { path: "a.ts", content: "x" } },
    ];
    calls.push(...reads(13));
    const { outcome, events, llmCalls } = await runWithBody(
      JSON.stringify(calls),
      { repairBody: JSON.stringify(reads(1)) },
    );
    expect(events.filter((e) => e.type === "batch_wave_split")).toHaveLength(0);
    expect(events.filter((e) => e.type === "parse_retry")).toHaveLength(1);
    expect(events.filter((e) => e.type === "batch_trimmed")).toHaveLength(0);
    expect(llmCalls).toBe(2);
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]!.tool).toBe("os.fs.read");
  });

  it.each([
    ["terminal mid-batch", [{ tool: "reply", args: { text: "hi" } }], 13],
    ["unknown class", [{ tool: "mystery.tool", args: {} }], 13],
  ] as const)(
    "routes an oversized batch containing %s to repair (no wave split, no trim)",
    async (_label, first, rest) => {
      const calls = [...first, ...reads(rest)];
      const { outcome, events, llmCalls } = await runWithBody(
        JSON.stringify(calls),
        { repairBody: JSON.stringify(reads(1)) },
      );
      expect(events.filter((e) => e.type === "batch_wave_split")).toHaveLength(
        0,
      );
      expect(events.filter((e) => e.type === "parse_retry")).toHaveLength(1);
      expect(llmCalls).toBe(2);
      expect(outcome.toolCalls).toHaveLength(1);
    },
  );
});

function mockCompletion(
  content: string,
  extra: Partial<CompletionResult> = {},
): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 20, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
    ...extra,
  };
}

/** Registry whose tools log `start`/`end` so tests can see the dispatch order. */
function orderLoggingRegistry(log: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  const register = (name: string, delayMs = 0): void => {
    registry.register({
      name,
      description: name,
      readonly: false,
      async run(args) {
        const target = String(args.path ?? args.command ?? args.text ?? "");
        log.push(`start ${name} ${target}`);
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        log.push(`end ${name} ${target}`);
        return compressToolResult({
          tool: name,
          status: "ok",
          output: `${name} ${target}`,
        });
      },
    });
  };
  register("os.fs.read", 25);
  register("os.fs.write", 5);
  register("os.fs.edit");
  register("os.shell.run");
  register("reply");
  return registry;
}

describe("executeStep approval-gated batches that would not prompt", () => {
  const grammarsDir = join(process.cwd(), "grammars");

  async function run(
    body: string,
    approvalPosture?: StepApprovalPostureSource,
  ): Promise<{
    outcome: Awaited<ReturnType<typeof executeStep>>;
    log: string[];
    events: StepEvent[];
  }> {
    const log: string[] = [];
    const events: StepEvent[] = [];
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const outcome = await executeStep(
      {
        session: createEmptySessionState({ id: "s-in-order", workingDir: "/w" }),
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
      },
      {
        registry: orderLoggingRegistry(log),
        slotManager: new SlotManager(2),
        llmComplete: async () => mockCompletion(body),
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
        onEvent: (event) => events.push(event),
        ...(approvalPosture ? { approvalPosture } : {}),
      },
    );
    return { outcome, log, events };
  }

  const LEVEL_5: StepApprovalPostureSource = { getLevel: () => 5 };

  it("runs every call of a 5-write batch at level 5 instead of keeping the first", async () => {
    const files = ["a.js", "b.js", "c.js", "d.js"];
    const body = JSON.stringify([
      ...files.map((path) => ({
        tool: "os.fs.write",
        args: { path, content: "x" },
      })),
      {
        tool: "os.fs.edit",
        args: { path: "a.js", oldString: "x", newString: "y" },
      },
    ]);
    const { outcome, log, events } = await run(body, LEVEL_5);

    expect(outcome.toolCalls.map((c) => c.tool)).toEqual([
      "os.fs.write",
      "os.fs.write",
      "os.fs.write",
      "os.fs.write",
      "os.fs.edit",
    ]);
    expect(outcome.toolResults.every((r) => r.status === "ok")).toBe(true);
    expect(log.filter((l) => l.startsWith("start"))).toEqual([
      "start os.fs.write a.js",
      "start os.fs.write b.js",
      "start os.fs.write c.js",
      "start os.fs.write d.js",
      "start os.fs.edit a.js",
    ]);
    expect(events.filter((e) => e.type === "batch_trimmed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "parse_retry")).toHaveLength(0);
    expect(outcome.trimmedBatchNotice).toBeUndefined();
    const executed = events.flatMap((e) =>
      e.type === "tool_call_executed" ? [[e.batchIndex, e.batchSize]] : [],
    );
    expect(executed).toEqual([
      [0, 5],
      [1, 5],
      [2, 5],
      [3, 5],
      [4, 5],
    ]);
    expect(outcome.terminal).toBeNull();
  });

  it("dispatches each call only after the previous one settled, across resource classes", async () => {
    // The read is the slowest call. Grouped execution would start the
    // write alongside it; in-order execution must not.
    const body = JSON.stringify([
      { tool: "os.fs.read", args: { path: "x" } },
      { tool: "os.fs.write", args: { path: "x", content: "1" } },
      { tool: "os.fs.read", args: { path: "x" } },
    ]);
    const { log } = await run(body, LEVEL_5);
    expect(log).toEqual([
      "start os.fs.read x",
      "end os.fs.read x",
      "start os.fs.write x",
      "end os.fs.write x",
      "start os.fs.read x",
      "end os.fs.read x",
    ]);
  });

  it("closes the turn when the in-order batch ends in reply", async () => {
    const body = JSON.stringify([
      { tool: "os.fs.write", args: { path: "a", content: "1" } },
      { tool: "os.fs.write", args: { path: "b", content: "2" } },
      { tool: "reply", args: { text: "wrote a and b" } },
    ]);
    const { outcome, log, events } = await run(body, LEVEL_5);
    expect(outcome.terminal).toBe("turn");
    expect(log.filter((l) => l.startsWith("start"))).toEqual([
      "start os.fs.write a",
      "start os.fs.write b",
      "start reply wrote a and b",
    ]);
    expect(
      events.filter((e) => e.type === "assistant_reply").map((e) => e.type),
    ).toEqual(["assistant_reply"]);
  });

  it("still trims when a gated call could prompt (fs write below level 5)", async () => {
    const body = JSON.stringify([
      { tool: "os.fs.write", args: { path: "a", content: "1" } },
      { tool: "os.fs.write", args: { path: "b", content: "2" } },
    ]);
    const { outcome, log, events } = await run(body, { getLevel: () => 4 });
    expect(outcome.toolCalls).toHaveLength(1);
    expect(log).toEqual(["start os.fs.write a", "end os.fs.write a"]);
    expect(events.filter((e) => e.type === "batch_trimmed")).toHaveLength(1);
    expect(outcome.trimmedBatchNotice).toContain(
      "Dropped from the batch — retry",
    );
  });

  it("still trims when no approval posture is wired", async () => {
    const body = JSON.stringify([
      { tool: "os.fs.write", args: { path: "a", content: "1" } },
      { tool: "os.fs.write", args: { path: "b", content: "2" } },
    ]);
    const { outcome } = await run(body);
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.trimmedBatchNotice).toBeDefined();
  });

  it("uses the session's category grants: a shell grant runs a shell batch whole, not a write", async () => {
    const shellGrant: StepApprovalPostureSource = {
      getLevel: () => 1,
      sessionGrants: () => ({ categories: ["shell"] }),
    };
    const shells = JSON.stringify([
      { tool: "os.shell.run", args: { command: "ls" } },
      { tool: "os.shell.run", args: { command: "pwd" } },
    ]);
    const whole = await run(shells, shellGrant);
    expect(whole.outcome.toolCalls).toHaveLength(2);
    expect(whole.outcome.trimmedBatchNotice).toBeUndefined();

    const mixed = JSON.stringify([
      { tool: "os.shell.run", args: { command: "ls" } },
      { tool: "os.fs.write", args: { path: "a", content: "1" } },
    ]);
    const trimmed = await run(mixed, shellGrant);
    expect(trimmed.outcome.toolCalls).toHaveLength(1);
    expect(trimmed.outcome.trimmedBatchNotice).toBeDefined();
  });

  it("does not run a gated batch past the wave-split ceiling, even at level 5", async () => {
    const body = JSON.stringify(
      Array.from({ length: 33 }, (_, i) => ({
        tool: "os.fs.write",
        args: { path: `f${i}`, content: "x" },
      })),
    );
    await expect(run(body, LEVEL_5)).rejects.toThrow(/maxParallelToolCalls/);
  });
});

describe("fabricated tool transcripts", () => {
  const FABRICATED = [
    "I'll write the scene module and test it.",
    'assistant_tool_call: os.fs.write {"path":"js/scene.js","content":"export const x = 1;"}',
    "tool_result[os.fs.write ok]: wrote 20 bytes to js/scene.js",
    'assistant_tool_call: os.shell.run {"command":"node test.js"}',
    "tool_result[os.shell.run ok]: ALL ASSERTIONS PASSED!",
    "We are ready to provide the final reply.",
  ].join("\n");

  const NOTICE =
    "Your last response contained 2 tool calls written as plain text. " +
    "None of them ran and their results were invented. " +
    "Call tools natively — nothing is done until a real tool result comes back.";

  describe("detectFabricatedToolTranscript", () => {
    it("counts transcript lines written as text", () => {
      expect(detectFabricatedToolTranscript(FABRICATED)).toEqual({
        calls: 2,
        results: 2,
      });
    });

    it("accepts a bare tool_call: prefix and error results", () => {
      const text = [
        'tool_call: os.fs.read {"path":"a"}',
        "tool_result[os.fs.read error]: ENOENT",
      ].join("\n");
      expect(detectFabricatedToolTranscript(text)).toEqual({
        calls: 1,
        results: 1,
      });
    });

    it("counts a transcript inside a fence that is never closed", () => {
      const text = ["```", ...FABRICATED.split("\n")].join("\n");
      expect(detectFabricatedToolTranscript(text)).toEqual({
        calls: 2,
        results: 2,
      });
    });

    it.each([
      [
        "prose that quotes one line",
        "The build passed.\ntool_result[os.shell.run ok]: 12 tests passed\nThat is the last run.",
      ],
      [
        "inline mentions",
        "The `tool_result[os.fs.write ok]:` line and the `assistant_tool_call: os.fs.write {…}` line\nare how history is rendered.",
      ],
      [
        "bullets and quotes",
        "- tool_result[os.fs.read ok]: a\n> tool_result[os.fs.read ok]: b\n* assistant_tool_call: os.fs.read {}",
      ],
      [
        "a closed code fence quoting the format",
        "History looks like this:\n```\nassistant_tool_call: os.fs.read {\"path\":\"a\"}\ntool_result[os.fs.read ok]: hello\n```\nThat is all.",
      ],
      [
        "a JSON tool-call array",
        JSON.stringify([
          { tool: "os.fs.write", args: { path: "a", content: "tool_result[x ok]: y\nz" } },
        ]),
      ],
      ["a call line without arguments", "assistant_tool_call: done\ntool_call: nothing here"],
    ])("ignores %s", (_label, text) => {
      expect(detectFabricatedToolTranscript(text)).toBeNull();
    });

    it("renders the notice, without claiming invented results when there were none", () => {
      expect(formatFabricatedTranscriptNotice({ calls: 2, results: 2 })).toBe(
        NOTICE,
      );
      expect(formatFabricatedTranscriptNotice({ calls: 3, results: 0 })).toBe(
        "Your last response contained 3 tool calls written as plain text. None of them ran. " +
          "Call tools natively — nothing is done until a real tool result comes back.",
      );
    });
  });

  describe("executeStep", () => {
    function toolCall(id: string, name: string, args: Record<string, unknown>) {
      return {
        id,
        type: "function" as const,
        function: { name, arguments: JSON.stringify(args) },
      };
    }

    async function runNative(
      completion: CompletionResult,
      approvalPosture?: StepApprovalPostureSource,
    ): Promise<{
      outcome: Awaited<ReturnType<typeof executeStep>>;
      log: string[];
      events: StepEvent[];
    }> {
      const log: string[] = [];
      const events: StepEvent[] = [];
      const outcome = await executeStep(
        {
          session: createEmptySessionState({ id: "s-fabricated", workingDir: "/w" }),
          toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
          capabilities: CAPS,
          skillCatalog: SKILLS,
          stepIndex: 0,
          signal: new AbortController().signal,
          userMessage: "build the scene",
        },
        {
          registry: orderLoggingRegistry(log),
          slotManager: new SlotManager(2),
          llmComplete: async () => completion,
          grammar: "",
          profile: PLAIN_INSTRUCT_PROFILE,
          toolTransport: "native_tools",
          toolCallAdapter: null,
          supportsSlotAffinity: false,
          onEvent: (event) => events.push(event),
          ...(approvalPosture ? { approvalPosture } : {}),
        },
      );
      return { outcome, log, events };
    }

    it("does not accept a native reply that follows an invented transcript", async () => {
      const { outcome, log, events } = await runNative(
        mockCompletion(FABRICATED, {
          toolCalls: [
            toolCall("c1", "reply", { text: "Implemented js/scene.js and verified it." }),
          ],
        }),
      );
      expect(outcome.terminal).toBeNull();
      expect(log).toEqual([]);
      expect(outcome.toolCalls.map((c) => c.tool)).toEqual(["reply"]);
      expect(outcome.toolResults[0]!.status).toBe("error");
      expect(outcome.toolResults[0]!.summary).toContain("not delivered");
      expect(events.some((e) => e.type === "assistant_reply")).toBe(false);
      expect(outcome.trimmedBatchNotice).toBe(NOTICE);
      // The rejected reply is in the trace pair like any other call.
      const parsed = events.flatMap((e) =>
        e.type === "tool_call_parsed" ? [e.call.tool] : [],
      );
      const executed = events.flatMap((e) =>
        e.type === "tool_call_executed" ? [e.result.status] : [],
      );
      expect(parsed).toEqual(["reply"]);
      expect(executed).toEqual(["error"]);
    });

    it("still runs genuine non-terminal native calls from the same completion", async () => {
      const { outcome, log } = await runNative(
        mockCompletion(FABRICATED, {
          toolCalls: [
            toolCall("c1", "os__fs__read", { path: "js/scene.js" }),
            toolCall("c2", "reply", { text: "done" }),
          ],
        }),
      );
      expect(log).toEqual(["start os.fs.read js/scene.js", "end os.fs.read js/scene.js"]);
      expect(outcome.toolCalls.map((c) => c.tool)).toEqual(["os.fs.read", "reply"]);
      expect(outcome.toolResults.map((r) => r.status)).toEqual(["ok", "error"]);
      expect(outcome.terminal).toBeNull();
      expect(outcome.trimmedBatchNotice).toBe(NOTICE);
    });

    it("runs genuine native writes in order and drops only the reply at level 5", async () => {
      const { outcome, log } = await runNative(
        mockCompletion(FABRICATED, {
          toolCalls: [
            toolCall("c1", "os__fs__write", { path: "a.js", content: "1" }),
            toolCall("c2", "os__fs__write", { path: "b.js", content: "2" }),
            toolCall("c3", "reply", { text: "done" }),
          ],
        }),
        { getLevel: () => 5 },
      );
      expect(log.filter((l) => l.startsWith("start"))).toEqual([
        "start os.fs.write a.js",
        "start os.fs.write b.js",
      ]);
      expect(outcome.toolCalls.map((c) => c.tool)).toEqual([
        "os.fs.write",
        "os.fs.write",
        "reply",
      ]);
      expect(outcome.terminal).toBeNull();
      expect(outcome.trimmedBatchNotice).toBe(NOTICE);
    });

    it("suppresses the reply synthesised from text-only content and clips it in the transcript", async () => {
      const longText = `${FABRICATED}\n${"x".repeat(5000)}`;
      const { outcome, log } = await runNative(mockCompletion(longText));
      expect(log).toEqual([]);
      expect(outcome.terminal).toBeNull();
      expect(outcome.toolCalls.map((c) => c.tool)).toEqual(["reply"]);
      const text = String(outcome.toolCalls[0]!.args.text);
      expect(text.length).toBeLessThan(600);
      expect(text).toContain("more chars not delivered");
      expect(outcome.trimmedBatchNotice).toBe(NOTICE);
    });

    it("accepts a reply whose prose quotes a single transcript line", async () => {
      const { outcome, log } = await runNative(
        mockCompletion(
          "The last run said:\ntool_result[os.shell.run ok]: 12 tests passed",
          { toolCalls: [toolCall("c1", "reply", { text: "All 12 tests pass." })] },
        ),
      );
      expect(outcome.terminal).toBe("turn");
      expect(log).toEqual(["start reply All 12 tests pass.", "end reply All 12 tests pass."]);
      expect(outcome.trimmedBatchNotice).toBeUndefined();
    });

    describe("a stream the consumer cut short", () => {
      const SIX_LINES = [
        "I'll write the scene module and test it.",
        'assistant_tool_call: os.fs.write {"path":"js/scene.js","content":"export const x = 1;"}',
        "tool_result[os.fs.write ok]: wrote 20 bytes to js/scene.js",
        'assistant_tool_call: os.shell.run {"command":"node test.js"}',
        "tool_result[os.shell.run ok]: ALL ASSERTIONS PASSED!",
        'assistant_tool_call: os.fs.write {"path":"js/main.js","content":"import x"}',
        "tool_result[os.fs.write ok]: wrote 8 bytes to js/main.js",
        "",
      ].join("\n");
      const EARLY_STOP = {
        reason: "fabricated_transcript" as const,
        calls: 3,
        results: 3,
      };

      async function runStreamed(completion: CompletionResult): Promise<{
        outcome: Awaited<ReturnType<typeof executeStep>>;
        log: string[];
        events: StepEvent[];
      }> {
        const log: string[] = [];
        const events: StepEvent[] = [];
        const outcome = await executeStep(
          {
            session: createEmptySessionState({ id: "s-cut", workingDir: "/w" }),
            toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
            capabilities: CAPS,
            skillCatalog: SKILLS,
            stepIndex: 0,
            signal: new AbortController().signal,
            userMessage: "build the scene",
          },
          {
            registry: orderLoggingRegistry(log),
            slotManager: new SlotManager(2),
            // No second request of any kind: the cut completion is judged
            // as it stands, not repaired.
            llmComplete: async () => {
              throw new Error("a cut completion must not trigger another request");
            },
            llmCompleteStream: async function* () {
              for (const line of completion.content.split(/(?<=\n)/)) {
                yield { delta: line, reasoningDelta: "", done: false };
              }
              return completion;
            },
            grammar: "",
            profile: PLAIN_INSTRUCT_PROFILE,
            toolTransport: "native_tools",
            toolCallAdapter: null,
            supportsSlotAffinity: false,
            onEvent: (event) => events.push(event),
          },
        );
        return { outcome, log, events };
      }

      it("delivers no reply, runs nothing and injects the notice", async () => {
        const { outcome, log, events } = await runStreamed(
          mockCompletion(SIX_LINES, {
            earlyStop: EARLY_STOP,
            finishReason: "fabricated_transcript",
          }),
        );
        expect(outcome.terminal).toBeNull();
        expect(log).toEqual([]);
        expect(outcome.toolCalls.map((c) => c.tool)).toEqual(["reply"]);
        expect(outcome.toolResults[0]!.status).toBe("error");
        expect(outcome.toolResults[0]!.summary).toContain("not delivered");
        expect(events.some((e) => e.type === "assistant_reply")).toBe(false);
        expect(events.some((e) => e.type === "step_error")).toBe(false);
        expect(outcome.trimmedBatchNotice).toBe(
          "Your last response contained 3 tool calls written as plain text. " +
            "None of them ran and their results were invented. " +
            "Call tools natively — nothing is done until a real tool result comes back.",
        );
      });

      it("still runs a native call that had fully arrived before the cut", async () => {
        const { outcome, log } = await runStreamed(
          mockCompletion(SIX_LINES, {
            earlyStop: EARLY_STOP,
            finishReason: "fabricated_transcript",
            toolCalls: [toolCall("c1", "os__fs__read", { path: "js/scene.js" })],
          }),
        );
        expect(log).toEqual([
          "start os.fs.read js/scene.js",
          "end os.fs.read js/scene.js",
        ]);
        expect(outcome.toolCalls.map((c) => c.tool)).toEqual(["os.fs.read"]);
        expect(outcome.terminal).toBeNull();
        expect(outcome.trimmedBatchNotice).toContain(
          "3 tool calls written as plain text",
        );
      });

      it("trusts the cut when the detector cannot see the lines in what came back", async () => {
        const { outcome, log } = await runStreamed(
          mockCompletion("Working on the scene now.\n", {
            earlyStop: { reason: "fabricated_transcript", calls: 4, results: 2 },
          }),
        );
        expect(log).toEqual([]);
        expect(outcome.terminal).toBeNull();
        expect(outcome.toolResults.map((r) => r.status)).toEqual(["error"]);
        expect(outcome.trimmedBatchNotice).toBe(
          "Your last response contained 4 tool calls written as plain text. " +
            "None of them ran and their results were invented. " +
            "Call tools natively — nothing is done until a real tool result comes back.",
        );
      });
    });
  });
});

describe("executeStep streaming reasoning accumulator", () => {
  // Regression for the Fix B side of the "degenerate-loop + empty
  // reasoningContent" investigation. Before the fix `consumeStream` only
  // routed parser-derived `reasoning_delta` events to the UI sink and
  // never accumulated them into `CompletionResult.reasoningContent`, so
  // the legacy `/completion` endpoint (which never emits a dedicated
  // `reasoning_content` SSE channel) left the field empty. Traces then
  // showed `reasoning_len=0` everywhere even when the model genuinely
  // produced a `<think>...</think>` / `<|channel>thought` block.
  let grammarsDir: string;

  beforeEach(() => {
    grammarsDir = join(process.cwd(), "grammars");
  });

  async function runStreaming(args: {
    chunks: Array<{ delta: string; reasoningDelta: string; done: boolean }>;
    finalContent: string;
    finalReasoning: string;
  }): Promise<{
    captured: import("../llm/llama-server-client.js").CompletionResult | null;
  }> {
    const registry = new ToolRegistry();
    registry.register({
      name: "reply",
      description: "reply",
      readonly: true,
      async run(args) {
        return compressToolResult({
          tool: "reply",
          status: "ok",
          output: String(args.text ?? ""),
        });
      },
    });
    const grammar = await buildGrammar(QWEN_THINK_PROFILE, grammarsDir);
    const session = createEmptySessionState({
      id: "s-stream",
      workingDir: "/w",
    });
    const finalCompletion = {
      content: args.finalContent,
      reasoningContent: args.finalReasoning,
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
      modelId: "mock",
    } as const;
    let captured:
      import("../llm/llama-server-client.js").CompletionResult | null = null;
    await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "hi",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async () => finalCompletion,
        llmCompleteStream: async function* () {
          for (const chunk of args.chunks) yield chunk;
          return finalCompletion;
        },
        grammar,
        profile: QWEN_THINK_PROFILE,
        onCompletion: (c) => {
          captured = c;
        },
      },
    );
    return { captured };
  }

  it("falls back to parser-derived reasoning when channel A is empty", async () => {
    const reasoningBody = "thinking about it for a moment";
    const replyJson = '[{"tool":"reply","args":{"text":"hi"}}]';
    const { captured } = await runStreaming({
      chunks: [
        { delta: reasoningBody, reasoningDelta: "", done: false },
        { delta: "</think>\n", reasoningDelta: "", done: false },
        { delta: replyJson, reasoningDelta: "", done: false },
      ],
      finalContent: `${reasoningBody}</think>\n${replyJson}`,
      finalReasoning: "",
    });
    expect(captured).not.toBeNull();
    expect(captured!.reasoningContent).toBe(reasoningBody);
  });

  it("prefers channel A reasoning when both sources emit", async () => {
    // Hypothetical server that splits CoT into a dedicated SSE channel
    // *and* echoes the same text inline (some forks do this). The
    // accumulator must not double-count or pick the inline copy.
    const replyJson = '[{"tool":"reply","args":{"text":"hi"}}]';
    const channelABody = "channel-a reasoning";
    const { captured } = await runStreaming({
      chunks: [
        { delta: "", reasoningDelta: channelABody, done: false },
        { delta: "inline echo", reasoningDelta: "", done: false },
        { delta: "</think>\n", reasoningDelta: "", done: false },
        { delta: replyJson, reasoningDelta: "", done: false },
      ],
      finalContent: `inline echo</think>\n${replyJson}`,
      finalReasoning: "",
    });
    expect(captured).not.toBeNull();
    expect(captured!.reasoningContent).toBe(channelABody);
  });

  it("does not overwrite an already-populated server-side reasoningContent", async () => {
    // When the server returned a non-empty `reasoning_content` on the
    // final SSE done frame, we trust it and skip the patch entirely.
    const replyJson = '[{"tool":"reply","args":{"text":"hi"}}]';
    const { captured } = await runStreaming({
      chunks: [
        { delta: "inline body", reasoningDelta: "", done: false },
        { delta: "</think>\n", reasoningDelta: "", done: false },
        { delta: replyJson, reasoningDelta: "", done: false },
      ],
      finalContent: `inline body</think>\n${replyJson}`,
      finalReasoning: "server-authoritative reasoning",
    });
    expect(captured).not.toBeNull();
    expect(captured!.reasoningContent).toBe("server-authoritative reasoning");
  });
});

describe("executeStep remembers the transcript cut", () => {
  const grammarsDir = join(process.cwd(), "grammars");

  it("carries the packer's start on nextSession so the next step holds it", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "noop",
      description: "no-op",
      readonly: true,
      async run() {
        return compressToolResult({
          tool: "noop",
          status: "ok",
          output: "ok",
          details: {},
        });
      },
    });
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const base = createEmptySessionState({ id: "s-pack", workingDir: "/w" });
    const turns: typeof base.turns = [];
    for (let i = 0; i < 400; i += 1) {
      turns.push(
        { kind: "user", text: `ask ${i} ${"y".repeat(400)}`, at: 1 + i * 2 },
        { kind: "assistant_reply", text: `answer ${i}`, at: 2 + i * 2 },
      );
    }
    turns.push({ kind: "user", text: "now", at: 10_000 });
    const session = { ...base, turns };
    const complete = async () => ({
      content: JSON.stringify({ tool: "noop", args: {} }),
      reasoningContent: "",
      stop: true,
      truncated: false,
      timing: { promptMs: 1, predictedMs: 1, promptTokens: 20, predictedTokens: 5 },
      cacheHitTokens: 0,
      slotId: 0,
      modelId: "mock",
    });
    const deps = {
      registry,
      slotManager: new SlotManager(2),
      llmComplete: complete,
      grammar,
      profile: PLAIN_INSTRUCT_PROFILE,
    };
    const ctx = {
      toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      signal: new AbortController().signal,
      userMessage: "now",
    };

    const first = await executeStep(
      { ...ctx, session, stepIndex: 0 },
      deps,
    );
    expect(first.prompt.droppedTurns).toBeGreaterThan(0);
    const start = first.prompt.conversationPackStart;
    expect(start).not.toBeNull();
    expect(first.nextSession.conversationPackStart).toEqual(start);

    const second = await executeStep(
      { ...ctx, session: first.nextSession, stepIndex: 1 },
      deps,
    );
    expect(second.prompt.conversationPackStart).toEqual(start);
    expect(second.nextSession.conversationPackStart).toEqual(start);
    // Held: the second prompt's transcript is the first's plus this step.
    expect(second.prompt.droppedTurns).toBe(first.prompt.droppedTurns);
  });
});

describe("executeStep skill.view short-circuit", () => {
  const grammarsDir = join(process.cwd(), "grammars");

  it("short-circuits a skill.view for an already-loaded skill without invoking the tool", async () => {
    let viewCalls = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "skill.view",
      description: "view",
      readonly: true,
      async run() {
        viewCalls += 1;
        return compressToolResult({
          tool: "skill.view",
          status: "ok",
          output: "FULL SKILL BODY",
          details: { skillLoaded: { name: "exa", version: "1", body: "body" } },
        });
      },
    });

    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const base = createEmptySessionState({ id: "s-skill", workingDir: "/w" });
    const session = {
      ...base,
      loadedSkills: [
        { name: "exa", version: "1", body: "body", loadedAt: Date.now() },
      ],
    };
    const completionBody = JSON.stringify({
      tool: "skill.view",
      args: { name: "exa" },
    });

    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async () => ({
          content: completionBody,
          reasoningContent: "",
          stop: true,
          truncated: false,
          timing: {
            promptMs: 1,
            predictedMs: 1,
            promptTokens: 20,
            predictedTokens: 5,
          },
          cacheHitTokens: 0,
          slotId: 0,
          modelId: "mock",
        }),
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
      },
    );

    expect(viewCalls).toBe(0);
    expect(outcome.toolResults).toHaveLength(1);
    expect(outcome.toolResults[0]!.status).toBe("ok");
    expect(outcome.toolResults[0]!.summary).toContain("already loaded");
  });
});

describe("executeStep unparseable-completion fallback", () => {
  const grammarsDir = join(process.cwd(), "grammars");

  async function runQwenStep(content: string) {
    const registry = new ToolRegistry();
    registry.register(replyTool);
    const grammar = await buildGrammar(QWEN_THINK_PROFILE, grammarsDir);
    return executeStep(
      {
        session: createEmptySessionState({
          id: "s-fallback",
          workingDir: "/w",
        }),
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "hi",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async () => ({
          content,
          reasoningContent: "",
          stop: true,
          truncated: false,
          timing: {
            promptMs: 1,
            predictedMs: 1,
            promptTokens: 20,
            predictedTokens: 5,
          },
          cacheHitTokens: 0,
          slotId: 0,
          modelId: "mock",
        }),
        grammar,
        profile: QWEN_THINK_PROFILE,
      },
    );
  }

  it("degrades prose after a closed think block to a reply", async () => {
    // The `<think>` open tag is prefilled by the prompt, so the
    // completion starts inside the reasoning block.
    const outcome = await runQwenStep("thinking about it</think>Hi there!");
    expect(outcome.terminal).toBe("turn");
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]!.tool).toBe("reply");
    expect(outcome.toolCalls[0]!.args).toEqual({ text: "Hi there!" });
    expect(outcome.toolResults[0]!.status).toBe("ok");
  });

  it("still fails when the model never left its think block (issue #37)", async () => {
    await expect(
      runQwenStep("[SFC] 分析中 rambling that never closes"),
    ).rejects.toThrow(/tool-call/);
  });
});

describe("parallelToolCalls derivation (issue #104)", () => {
  const originalEnv = process.env.ATOMIC_AGENT_MAX_PARALLEL_TOOL_CALLS;

  beforeEach(() => {
    process.env.ATOMIC_AGENT_MAX_PARALLEL_TOOL_CALLS = originalEnv;
    resetConfigCache();
  });

  /** Minimal registry with a single `os.fs.read` tool. */
  function makeRegistry() {
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "read a file",
      readonly: true,
      async run(args) {
        return compressToolResult({
          tool: "os.fs.read",
          status: "ok",
          output: `read ${String(args.path)}`,
        });
      },
    });
    return registry;
  }

  /**
   * Run one native_tools step and capture the `LlmStreamParams` the
   * executor passes to `llmComplete`. The model emits a single
   * `os.fs.read` tool call so the request carries the tools payload.
   */
  async function captureStreamParams(deps?: {
    supportsParallelTools?: boolean;
    maxParallelToolCallsEnv?: string;
    strictTools?: boolean;
  }) {
    if (deps?.maxParallelToolCallsEnv !== undefined) {
      process.env.ATOMIC_AGENT_MAX_PARALLEL_TOOL_CALLS =
        deps.maxParallelToolCallsEnv;
      resetConfigCache();
    }
    const registry = makeRegistry();
    const session = createEmptySessionState({
      id: "s-parallel-flag",
      workingDir: "/w",
    });
    let captured: {
      parallelToolCalls?: boolean;
      tools?: ReadonlyArray<Record<string, unknown>>;
    } | null = null;
    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "read the file",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async (params) => {
          captured = {
            parallelToolCalls: params.parallelToolCalls,
            ...(params.tools ? { tools: params.tools } : {}),
          };
          return {
            content: JSON.stringify([
              {
                tool: "os.fs.read",
                args: { path: "/w/a.txt" },
              },
            ]),
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: 5,
            },
            cacheHitTokens: 0,
            slotId: -1,
            modelId: "mock",
          };
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
        ...(deps?.supportsParallelTools !== undefined
          ? { supportsParallelTools: deps.supportsParallelTools }
          : {}),
        ...(deps?.strictTools !== undefined
          ? { strictTools: deps.strictTools }
          : {}),
      },
    );
    expect(outcome.toolResults[0]?.status).toBe("ok");
    expect(captured).not.toBeNull();
    return captured!;
  }

  it("defaults to parallelToolCalls true when the cap > 1 and the provider is capable", async () => {
    const captured = await captureStreamParams();
    expect(captured.parallelToolCalls).toBe(true);
  });

  it("sends parallelToolCalls false when maxParallelToolCalls is 1", async () => {
    const captured = await captureStreamParams({
      maxParallelToolCallsEnv: "1",
    });
    expect(captured.parallelToolCalls).toBe(false);
  });

  it("sends parallelToolCalls false when the provider reports supportsParallelTools false, regardless of cap", async () => {
    const captured = await captureStreamParams({
      supportsParallelTools: false,
    });
    expect(captured.parallelToolCalls).toBe(false);
  });

  it("keeps parallelToolCalls true when cap > 1 and the provider is capable", async () => {
    const captured = await captureStreamParams({
      supportsParallelTools: true,
      maxParallelToolCallsEnv: "8",
    });
    expect(captured.parallelToolCalls).toBe(true);
  });

  /**
   * The fourth veto, and the one that is not a preference: OpenAI
   * documents that Structured Outputs is not compatible with parallel
   * function calls — a parallel call generated under strict mode "may
   * not match supplied schemas" — and says to send
   * `parallel_tool_calls: false`. A request that marks tools `strict`
   * and still asks for parallel calls buys best-effort adherence, which
   * is exactly the symptom `supportsTools: "strict"` exists to cure.
   */
  it("sends parallelToolCalls false under strict tools, whatever the cap says", async () => {
    const captured = await captureStreamParams({
      strictTools: true,
      supportsParallelTools: true,
      maxParallelToolCallsEnv: "8",
    });
    expect(
      captured.tools?.some(
        (t) =>
          (t.function as { strict?: boolean } | undefined)?.strict === true,
      ),
    ).toBe(true);
    expect(captured.parallelToolCalls).toBe(false);
  });

  it("reaches the wire body as parallel_tool_calls: false", async () => {
    // End to end, because that is the only place the two facts meet:
    // the executor decides, `buildOpenAiChatBody` serialises, and a
    // regression in either one is invisible from the other's tests.
    const captured = await captureStreamParams({
      strictTools: true,
      supportsParallelTools: true,
      maxParallelToolCallsEnv: "8",
    });
    const body = buildOpenAiChatBody(
      {
        prompt: "read the file",
        tools: captured.tools,
        ...(captured.parallelToolCalls !== undefined
          ? { parallelToolCalls: captured.parallelToolCalls }
          : {}),
      },
      "mercury-2.5",
      false,
    );
    expect(body.parallel_tool_calls).toBe(false);
  });

  it("leaves the wire body alone when the level is off", async () => {
    // The other half: no strict marking anywhere, so nothing about this
    // request may differ from what it was before the feature existed.
    const captured = await captureStreamParams({
      supportsParallelTools: true,
      maxParallelToolCallsEnv: "8",
    });
    expect(
      captured.tools?.some(
        (t) =>
          (t.function as { strict?: boolean } | undefined)?.strict === true,
      ),
    ).toBe(false);
    const body = buildOpenAiChatBody(
      {
        prompt: "read the file",
        tools: captured.tools,
        parallelToolCalls: captured.parallelToolCalls ?? true,
      },
      "mercury-2.5",
      false,
    );
    expect(body.parallel_tool_calls).toBe(true);
  });
});

describe("native_tools thinking-profile prompt hygiene (issue #283)", () => {
  // A think-tag prefill is a llama-server text-completion artifact. On
  // the native-tools chat transport the prompt ships as a chat message
  // to an OpenAI-compatible endpoint, where the literal `<think>` is at
  // best noise and at worst corrupted server-side (Ollama Cloud,
  // ollama/ollama#17248) — so it must never be sent there, and parsing
  // must never assume a prefill that was not sent.
  const grammarsDir = join(process.cwd(), "grammars");

  function makeReplyRegistry() {
    const registry = new ToolRegistry();
    registry.register({
      name: "reply",
      description: "reply",
      readonly: true,
      async run(args: Record<string, unknown>) {
        return compressToolResult({
          tool: "reply",
          status: "ok",
          output: String(args.text ?? ""),
        });
      },
    });
    return registry;
  }

  function mkCompletion(content: string) {
    return {
      content,
      reasoningContent: "",
      stop: true,
      truncated: false,
      timing: {
        promptMs: 1,
        predictedMs: 1,
        promptTokens: 20,
        predictedTokens: 5,
      },
      cacheHitTokens: 0,
      slotId: -1,
      modelId: "mock-cloud",
    };
  }

  it("native_tools: the prompt carries no trailing <think> prefill and the reply is not mis-parsed as reasoning", async () => {
    const session = createEmptySessionState({
      id: "s-283-a",
      workingDir: "/w",
    });
    const prompts: string[] = [];
    const events: Array<{ type: string; text?: string }> = [];
    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "hi",
      },
      {
        registry: makeReplyRegistry(),
        slotManager: new SlotManager(2),
        llmComplete: async (params) => {
          prompts.push(params.prompt);
          return mkCompletion("All done.");
        },
        grammar: "",
        profile: QWEN_THINK_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
        onEvent: (ev) => {
          events.push(ev as { type: string; text?: string });
        },
      },
    );

    // The literal open tag must not reach the chat endpoint.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.trimEnd().endsWith("<think>")).toBe(false);
    // ...and the plain-prose reply must not be re-prefixed with `<think>`
    // and swallowed whole as reasoning.
    expect(events.some((ev) => ev.type === "reasoning")).toBe(false);
    expect(outcome.nextSession.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "All done.",
    });
  });

  it("native_tools: streamed content deltas are not reclassified as pre-opened reasoning", async () => {
    const session = createEmptySessionState({
      id: "s-283-b",
      workingDir: "/w",
    });
    const events: Array<{ type: string }> = [];
    let captured:
      import("../llm/llama-server-client.js").CompletionResult | null = null;
    const finalCompletion = mkCompletion("Answer text");
    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "hi",
      },
      {
        registry: makeReplyRegistry(),
        slotManager: new SlotManager(2),
        llmComplete: async () => finalCompletion,
        llmCompleteStream: async function* () {
          yield { delta: "Answer ", reasoningDelta: "", done: false };
          yield { delta: "text", reasoningDelta: "", done: false };
          return finalCompletion;
        },
        grammar: "",
        profile: QWEN_THINK_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
        onCompletion: (c) => {
          captured = c;
        },
        onEvent: (ev) => {
          events.push(ev as { type: string });
        },
      },
    );

    // Without the fix the stream parser starts in `inside_think` and
    // reclassifies the whole reply as reasoning (flushed at stream end
    // into `reasoningContent` and surfaced as reasoning events).
    expect(events.some((ev) => ev.type === "reasoning_delta")).toBe(false);
    expect(events.some((ev) => ev.type === "reasoning")).toBe(false);
    expect(captured).not.toBeNull();
    expect(captured!.reasoningContent).toBe("");
    expect(outcome.nextSession.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "Answer text",
    });
  });

  it("native_tools: the one-shot repair prompt does not re-append the reasoning prefill", async () => {
    const session = createEmptySessionState({
      id: "s-283-c",
      workingDir: "/w",
    });
    const prompts: string[] = [];
    // Two terminal `reply` calls in one batch fail validation and route
    // through the repair path.
    const badBatch = JSON.stringify([
      { tool: "reply", args: { text: "a" } },
      { tool: "reply", args: { text: "b" } },
    ]);
    const goodBatch = JSON.stringify([
      { tool: "reply", args: { text: "fixed" } },
    ]);
    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "hi",
      },
      {
        registry: makeReplyRegistry(),
        slotManager: new SlotManager(2),
        llmComplete: async (params) => {
          prompts.push(params.prompt);
          return mkCompletion(prompts.length === 1 ? badBatch : goodBatch);
        },
        grammar: "",
        profile: QWEN_THINK_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
      },
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("### tool-call-repair");
    expect(prompts[1]!.trimEnd().endsWith("<think>")).toBe(false);
    expect(outcome.toolResults[0]?.status).toBe("ok");
  });

  it("grammar transport regression: prefill still sent and reasoning still extracted", async () => {
    const registry = makeReplyRegistry();
    const grammar = await buildGrammar(QWEN_THINK_PROFILE, grammarsDir);
    const session = createEmptySessionState({
      id: "s-283-d",
      workingDir: "/w",
    });
    const prompts: string[] = [];
    const reasoningEvents: string[] = [];
    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "hi",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async (params) => {
          prompts.push(params.prompt);
          // Grammar output starts mid-think: body + close tag + array.
          return {
            ...mkCompletion(
              'thinking it over</think>\n[{"tool":"reply","args":{"text":"hi"}}]',
            ),
            slotId: 0,
            modelId: "mock-local",
          };
        },
        grammar,
        profile: QWEN_THINK_PROFILE,
        toolTransport: "grammar",
        toolCallAdapter: null,
        supportsSlotAffinity: true,
        onEvent: (ev) => {
          if (ev.type === "reasoning") reasoningEvents.push(ev.text);
        },
      },
    );

    expect(prompts[0]!.trimEnd().endsWith("<think>")).toBe(true);
    expect(reasoningEvents).toEqual(["thinking it over"]);
    expect(outcome.nextSession.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "hi",
    });
  });

  it("cross-transport fallover: a grammar-served stream (servedTransport stamp) keeps LIVE reasoning deltas under a native primary", async () => {
    // The documented default hybrid chain: cloud native primary with a
    // grammar local last resort (`appendLocal`). During an outage the
    // sticky override serves every turn from the grammar link, whose
    // GBNF output starts mid-`<think>` — the stream parser must adopt
    // the SERVED transport (stamped on each chunk by the fallback seam)
    // or live reasoning classification silently dies for the whole
    // outage window.
    const session = createEmptySessionState({
      id: "s-283-e",
      workingDir: "/w",
    });
    const raw =
      'pondering deeply about it</think>\n[{"tool":"reply","args":{"text":"hi"}}]';
    const finalCompletion = {
      ...{
        content: raw,
        reasoningContent: "",
        stop: true,
        truncated: false,
        timing: {
          promptMs: 1,
          predictedMs: 1,
          promptTokens: 20,
          predictedTokens: 5,
        },
        cacheHitTokens: 0,
        slotId: 0,
        modelId: "mock-local",
      },
      servedTransport: "grammar" as const,
    };
    const reasoningDeltas: string[] = [];
    const reasoningEvents: string[] = [];
    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "hi",
      },
      {
        registry: makeReplyRegistry(),
        slotManager: new SlotManager(2),
        llmComplete: async () => finalCompletion,
        llmCompleteStream: async function* () {
          const stamp = {
            reasoningDelta: "",
            done: false,
            servedTransport: "grammar" as const,
          };
          yield { ...stamp, delta: "pondering deeply" };
          yield { ...stamp, delta: " about it</think>\n" };
          yield { ...stamp, delta: '[{"tool":"reply","args":{"text":"hi"}}]' };
          return finalCompletion;
        },
        grammar: "",
        profile: QWEN_THINK_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
        onEvent: (ev) => {
          if (ev.type === "reasoning_delta") reasoningDeltas.push(ev.text);
          if (ev.type === "reasoning") reasoningEvents.push(ev.text);
        },
      },
    );

    // Live classification: the reasoning streamed as deltas while the
    // model was still generating, not just post-hoc at parse time.
    expect(reasoningDeltas.join("")).toBe("pondering deeply about it");
    expect(reasoningEvents).toEqual(["pondering deeply about it"]);
    expect(outcome.nextSession.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "hi",
    });
  });

  it("cross-transport fallover: a native-served completion under a grammar primary is not swallowed as reasoning", async () => {
    // The reverse (documented-unsupported) ordering: grammar primary,
    // native-tools link below it. A chat completion never continues our
    // text-completion prefill — prepending `<think>` here would swallow
    // the clean reply whole as reasoning.
    const session = createEmptySessionState({
      id: "s-283-f",
      workingDir: "/w",
    });
    const events: Array<{ type: string; text?: string }> = [];
    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "hi",
      },
      {
        registry: makeReplyRegistry(),
        slotManager: new SlotManager(2),
        llmComplete: async () => ({
          ...mkCompletion("Just the answer."),
          servedTransport: "native_tools" as const,
        }),
        grammar: "",
        profile: QWEN_THINK_PROFILE,
        toolTransport: "grammar",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
        onEvent: (ev) => {
          events.push(ev as { type: string; text?: string });
        },
      },
    );

    expect(events.some((ev) => ev.type === "reasoning")).toBe(false);
    expect(outcome.nextSession.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "Just the answer.",
    });
  });
});

describe("executeStep raw-network-failure classification", () => {
  const grammarsDir = join(process.cwd(), "grammars");

  async function runFailingStep(thrown: unknown) {
    const registry = new ToolRegistry();
    registry.register(replyTool);
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    return executeStep(
      {
        session: createEmptySessionState({ id: "s-net", workingDir: "/w" }),
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "hi",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async () => {
          throw thrown;
        },
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
      },
    );
  }

  it("surfaces undici's `fetch failed` as TransportError, not ToolExecutionError", async () => {
    // A surface that does not wrap its own errors (MCP streamable-http,
    // embeddings, a vendor SDK with its own fetch) throws this shape.
    // Filing it as a tool failure both mislabels the turn and stops the
    // provider fallback chain from advancing.
    const inner = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:19091"),
      { code: "ECONNREFUSED" },
    );
    const thrown = Object.assign(new TypeError("fetch failed"), {
      cause: inner,
    });
    await expect(runFailingStep(thrown)).rejects.toMatchObject({
      name: "TransportError",
      category: "transport",
    });
  });

  it("still reports a genuine runtime bug as a tool failure", async () => {
    await expect(
      runFailingStep(new TypeError("x.map is not a function")),
    ).rejects.toMatchObject({ name: "ToolExecutionError", category: "tool" });
  });
});

describe("executeStep empty-completion repair", () => {
  const grammarsDir = join(process.cwd(), "grammars");

  /**
   * Runs one grammar-transport step over a scripted list of completion
   * bodies: the first is the initial call, the second the repair.
   */
  async function runGrammarStep(bodies: string[]) {
    const registry = new ToolRegistry();
    registry.register(replyTool);
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    let calls = 0;
    const outcome = await executeStep(
      {
        session: createEmptySessionState({ id: "s-empty", workingDir: "/w" }),
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "hi",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async () => {
          const content = bodies[calls] ?? "";
          calls += 1;
          return {
            content,
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: content.length,
            },
            cacheHitTokens: 0,
            slotId: 0,
            modelId: "mock",
          };
        },
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
      },
    );
    return { outcome, calls };
  }

  it("repairs an empty body instead of ending the turn", async () => {
    // ModelError(reason=empty) is the largest failure bucket in
    // production (Sentry CLI-2W/2X/2Z/5J/4R, ~500 events). An empty
    // grammar body is exactly what the one-shot repair recovers for
    // every other malformed completion.
    const { outcome, calls } = await runGrammarStep([
      "",
      JSON.stringify([{ tool: "reply", args: { text: "recovered" } }]),
    ]);
    expect(calls).toBe(2);
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]!.tool).toBe("reply");
    expect(outcome.toolResults[0]!.status).toBe("ok");
  });

  it("still fails with ModelError when the repair is empty too", async () => {
    await expect(runGrammarStep(["", ""])).rejects.toMatchObject({
      name: "ModelError",
      reason: "empty",
    });
  });
});

describe("executeStep ModelError transport tag", () => {
  const grammarsDir = join(process.cwd(), "grammars");

  /**
   * Runs one step whose completions are ALL empty, so the model-failure
   * path is the only exit, and returns the rejection for inspection.
   *
   * `servedTransport` stamps the completion the way the fallback chain
   * wrapper does on a cross-transport fallover, so the configured
   * transport and the effective one disagree.
   */
  async function runEmptyStep(opts: {
    toolTransport: "grammar" | "native_tools";
    servedTransport?: "grammar" | "native_tools";
  }) {
    const registry = new ToolRegistry();
    registry.register(replyTool);
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    return executeStep(
      {
        session: createEmptySessionState({
          id: "s-transport-tag",
          workingDir: "/w",
        }),
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "hi",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async () => ({
          content: "",
          reasoningContent: "",
          stop: true,
          truncated: false,
          timing: {
            promptMs: 1,
            predictedMs: 1,
            promptTokens: 20,
            predictedTokens: 0,
          },
          cacheHitTokens: 0,
          slotId: 0,
          modelId: "mock",
          ...(opts.servedTransport === undefined
            ? {}
            : { servedTransport: opts.servedTransport }),
        }),
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: opts.toolTransport,
        toolCallAdapter: null,
        supportsSlotAffinity: false,
      },
    );
  }

  it("tags a native_tools empty completion with transport=native_tools", async () => {
    // Sentry CLI-BA: `reason=empty` on native_tools is the by-design
    // route (nothing in any channel), so the tag has to say so.
    await expect(
      runEmptyStep({ toolTransport: "native_tools" }),
    ).rejects.toMatchObject({
      name: "ModelError",
      reason: "empty",
      transport: "native_tools",
    });
  });

  it("tags a twice-empty grammar completion with transport=grammar", async () => {
    // Same `reason=empty`, materially different story: the one-shot
    // repair ran and came back empty too.
    await expect(
      runEmptyStep({ toolTransport: "grammar" }),
    ).rejects.toMatchObject({
      name: "ModelError",
      reason: "empty",
      transport: "grammar",
    });
  });

  it("reports the SERVED transport, not the configured one, on a cross-transport fallover", async () => {
    // Configured native_tools, served by a grammar link: the response is
    // parsed as grammar, so the tag must read grammar.
    await expect(
      runEmptyStep({
        toolTransport: "native_tools",
        servedTransport: "grammar",
      }),
    ).rejects.toMatchObject({
      name: "ModelError",
      reason: "empty",
      transport: "grammar",
    });

    // And the mirror image: configured grammar, served by a native link.
    await expect(
      runEmptyStep({
        toolTransport: "grammar",
        servedTransport: "native_tools",
      }),
    ).rejects.toMatchObject({
      name: "ModelError",
      reason: "empty",
      transport: "native_tools",
    });
  });
});

describe("executeStep ModelError failure-stage tag", () => {
  const grammarsDir = join(process.cwd(), "grammars");

  /**
   * Runs one step over a scripted list of completions (index 0 is the
   * initial call, index 1 the one-shot repair) and reports how many LLM
   * calls actually happened, so a test can prove *which* throw site
   * fired rather than only what it threw.
   */
  async function runScriptedStep(opts: {
    toolTransport: ToolCallTransport;
    completions: Array<Partial<CompletionResult>>;
  }) {
    const registry = new ToolRegistry();
    registry.register(replyTool);
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    let calls = 0;
    const run = executeStep(
      {
        session: createEmptySessionState({
          id: "s-failure-stage",
          workingDir: "/w",
        }),
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "hi",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async (): Promise<CompletionResult> => {
          const scripted = opts.completions[calls] ?? { content: "" };
          calls += 1;
          return {
            content: "",
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: 1,
            },
            cacheHitTokens: 0,
            slotId: 0,
            modelId: "mock",
            ...scripted,
          };
        },
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: opts.toolTransport,
        toolCallAdapter: null,
        supportsSlotAffinity: false,
      },
    );
    return { run, calls: () => calls };
  }

  it("tags the first-attempt throw with stage=initial", async () => {
    // native_tools, nothing in any channel: the by-design route, and the
    // step ends on the first completion (no repair round-trip).
    const { run, calls } = await runScriptedStep({
      toolTransport: "native_tools",
      completions: [{ content: "", reasoningContent: "" }],
    });
    await expect(run).rejects.toMatchObject({
      name: "ModelError",
      reason: "empty",
      transport: "native_tools",
      stage: "initial",
    });
    expect(calls()).toBe(1);
  });

  it("tags the post-repair throw with stage=repair on the SAME reason+transport pair", async () => {
    // The counterexample to "native_tools + reason=empty means the
    // by-design route": `content` empty but `reasoning_content` present
    // satisfies `isNativeToolsEmptyCompletionHandledByParser`, so the
    // first throw site does NOT fire. The parse then fails, the one-shot
    // repair runs, the repair comes back with nothing in any channel,
    // and the SECOND site throws the identical
    // reason=empty + transport=native_tools pair. `stage` is the only
    // field that separates them — the Sentry fingerprint cannot, because
    // it keys off a frame basename and the shipped build is one file.
    const { run, calls } = await runScriptedStep({
      toolTransport: "native_tools",
      completions: [
        { content: "", reasoningContent: "Hmm, let me consider the options." },
        { content: "", reasoningContent: "" },
      ],
    });
    await expect(run).rejects.toMatchObject({
      name: "ModelError",
      reason: "empty",
      transport: "native_tools",
      stage: "repair",
    });
    expect(calls()).toBe(2);
  });

  it("tags a twice-empty grammar step with stage=repair", async () => {
    const { run, calls } = await runScriptedStep({
      toolTransport: "grammar",
      completions: [{ content: "" }, { content: "" }],
    });
    await expect(run).rejects.toMatchObject({
      name: "ModelError",
      reason: "empty",
      transport: "grammar",
      stage: "repair",
    });
    expect(calls()).toBe(2);
  });
});

describe("executeStep repair parse transport", () => {
  const grammarsDir = join(process.cwd(), "grammars");

  it("parses the REPAIR completion under the served transport, not the configured one", async () => {
    // Guards the `retryParseDeps` hoist at the repair-path parse: passing
    // the configured `deps` there instead makes the retry parse lose
    // served-transport awareness, which no other test notices.
    //
    // Configured grammar, served by a native link. The repair answers the
    // way a native link does — empty `content`, the call in `tool_calls`
    // — so a grammar-shaped parse sees an empty body and the step dies
    // with a GrammarError instead of replying.
    const registry = new ToolRegistry();
    registry.register(replyTool);
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    let calls = 0;
    const outcome = await executeStep(
      {
        session: createEmptySessionState({
          id: "s-repair-served-transport",
          workingDir: "/w",
        }),
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "hi",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async (): Promise<CompletionResult> => {
          calls += 1;
          if (calls === 1) {
            // Reasoning-only: survives the first-attempt ModelError check
            // (native rules), fails the parse, routes into the repair.
            return {
              content: "",
              reasoningContent: "I should answer, but I forgot the call.",
              stop: true,
              truncated: false,
              timing: {
                promptMs: 1,
                predictedMs: 1,
                promptTokens: 20,
                predictedTokens: 5,
              },
              cacheHitTokens: 0,
              slotId: 0,
              modelId: "mock",
              servedTransport: "native_tools",
            };
          }
          return {
            content: "",
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: 5,
            },
            cacheHitTokens: 0,
            slotId: 0,
            modelId: "mock",
            servedTransport: "native_tools",
            toolCalls: [
              {
                id: "call-repair",
                type: "function",
                function: {
                  name: "reply",
                  arguments: JSON.stringify({ text: "served-native" }),
                },
              },
            ],
          };
        },
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "grammar",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
      },
    );

    expect(calls).toBe(2);
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]!.tool).toBe("reply");
    expect(outcome.toolCalls[0]!.args).toEqual({ text: "served-native" });
    expect(outcome.toolResults[0]!.status).toBe("ok");
  });
});

describe("truncated completions", () => {
  function makeNativeRegistry() {
    const registry = new ToolRegistry();
    registry.register({
      name: "reply",
      description: "reply",
      readonly: true,
      async run(args: Record<string, unknown>) {
        return compressToolResult({
          tool: "reply",
          status: "ok",
          output: String(args.text ?? ""),
        });
      },
    });
    return registry;
  }

  function nativeCompletion(
    overrides: Partial<CompletionResult>,
  ): CompletionResult {
    return {
      content: "",
      reasoningContent: "",
      stop: true,
      truncated: false,
      timing: {
        promptMs: 1,
        predictedMs: 1,
        promptTokens: 20,
        predictedTokens: 5,
      },
      cacheHitTokens: 0,
      slotId: -1,
      modelId: "ornith-1.0-35b",
      ...overrides,
    };
  }

  function ctxFor(
    session: ReturnType<typeof createEmptySessionState>,
    maxTokens?: number,
  ) {
    return {
      session,
      toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      stepIndex: 0,
      signal: new AbortController().signal,
      userMessage: "x",
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    };
  }

  it("native_tools: a reply the server marked `length` fails closed even when its tool calls parse", async () => {
    // Pinned in full by native-tool-call-execution-integrity.test.ts
    // ("explicit finish_reason: length: executions = 0"): a cut reply
    // dispatches nothing — the agent loop re-asks with a different
    // request instead. Kept here so the truncation detail travels too.
    const session = createEmptySessionState({
      id: "s-trunc-closed",
      workingDir: "/w",
    });
    await expect(
      executeStep(ctxFor(session), {
        registry: makeNativeRegistry(),
        slotManager: new SlotManager(2),
        async llmComplete() {
          return nativeCompletion({
            stop: false,
            truncated: true,
            finishReason: "length",
            usage: {
              promptTokens: 6_000,
              completionTokens: 16_384,
              totalTokens: 22_384,
            },
            toolCalls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "reply",
                  arguments: JSON.stringify({ text: "done" }),
                },
              },
            ],
          });
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
      }),
    ).rejects.toMatchObject({
      name: "ModelError",
      reason: "truncated",
      truncation: { cause: "reply_cap" },
    });
  });

  it("native_tools: a cut short of the cap inside a known window is the provider's output limit", async () => {
    const session = createEmptySessionState({
      id: "s-trunc-limit",
      workingDir: "/w",
    });
    await expect(
      executeStep(ctxFor(session), {
        registry: makeNativeRegistry(),
        slotManager: new SlotManager(2),
        contextWindow: 131_072,
        async llmComplete() {
          return nativeCompletion({
            reasoningContent: "thinking…",
            stop: false,
            truncated: true,
            finishReason: "length",
            usage: {
              promptTokens: 6_000,
              completionTokens: 4_096,
              totalTokens: 10_096,
            },
          });
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
      }),
    ).rejects.toMatchObject({
      name: "ModelError",
      truncation: { cause: "output_limit", completionTokens: 4_096 },
    });
  });

  it("keeps the provider's own wording on a 400 that refuses the request's size", async () => {
    const session = createEmptySessionState({
      id: "s-size-400",
      workingDir: "/w",
    });
    await expect(
      executeStep(ctxFor(session), {
        registry: makeNativeRegistry(),
        slotManager: new SlotManager(2),
        async llmComplete() {
          throw new OpenAiHttpError(
            "openai provider 400: max_tokens is too large: 32768. This model supports at most 16384 completion tokens",
            400,
            "https://x/v1/chat/completions",
            false,
            null,
            "vendor",
          );
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
      }),
    ).rejects.toMatchObject({
      name: "TransportError",
      status: 400,
      message: expect.stringContaining("at most 16384 completion tokens"),
    });
  });

  it("native_tools: a call whose arguments were cut mid-JSON is a truncation, with the cause attached", async () => {
    const session = createEmptySessionState({
      id: "s-trunc-cut",
      workingDir: "/w",
    });
    await expect(
      executeStep(ctxFor(session), {
        registry: makeNativeRegistry(),
        slotManager: new SlotManager(2),
        async llmComplete() {
          return nativeCompletion({
            stop: false,
            truncated: true,
            finishReason: "length",
            usage: {
              promptTokens: 6_000,
              completionTokens: 16_384,
              totalTokens: 22_384,
            },
            toolCalls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "reply",
                  arguments: '{"text":"the reply was going to be very lo',
                },
              },
            ],
          });
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
      }),
    ).rejects.toMatchObject({
      name: "ModelError",
      reason: "truncated",
      stage: "initial",
      truncation: {
        cause: "reply_cap",
        completionTokens: 16_384,
        promptTokens: 6_000,
        // The config default `localModels.completionMaxTokens`.
        requestedMaxTokens: 16_384,
      },
    });
  });

  it("native_tools: a reply cut inside its reasoning is a truncation against the step's own cap", async () => {
    // The agent loop's retry hands the step a raised cap; the request
    // must carry it, and the failure detector must judge against it.
    const session = createEmptySessionState({
      id: "s-trunc-cap",
      workingDir: "/w",
    });
    const capsSeen: Array<number | undefined> = [];
    await expect(
      executeStep(ctxFor(session, 32_768), {
        registry: makeNativeRegistry(),
        slotManager: new SlotManager(2),
        async llmComplete({ maxTokens }) {
          capsSeen.push(maxTokens);
          return nativeCompletion({
            reasoningContent: "Let me think about this very carefully…",
            stop: false,
            truncated: true,
            finishReason: "length",
            usage: {
              promptTokens: 6_000,
              completionTokens: 32_768,
              totalTokens: 38_768,
            },
          });
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
      }),
    ).rejects.toMatchObject({
      name: "ModelError",
      truncation: { cause: "reply_cap", requestedMaxTokens: 32_768 },
    });
    expect(capsSeen).toEqual([32_768]);
  });

  it("native_tools: the one-shot repair runs under the step's cap, never the 1024 grammar cap", async () => {
    // A reasoning model on the chat transport thinks server-side; 1024
    // tokens is a guaranteed truncation there, which turned every repair
    // into `Turn failed [model]: model response truncated`.
    const session = createEmptySessionState({
      id: "s-trunc-repair",
      workingDir: "/w",
    });
    const capsSeen: Array<number | undefined> = [];
    let calls = 0;
    const outcome = await executeStep(ctxFor(session, 20_000), {
      registry: makeNativeRegistry(),
      slotManager: new SlotManager(2),
      async llmComplete({ maxTokens }) {
        capsSeen.push(maxTokens);
        calls += 1;
        if (calls === 1) {
          // Reasoning-only: survives the first check, fails the parse,
          // routes into the repair.
          return nativeCompletion({ reasoningContent: "I should reply now." });
        }
        return nativeCompletion({
          toolCalls: [
            {
              id: "call-repair",
              type: "function",
              function: {
                name: "reply",
                arguments: JSON.stringify({ text: "ok" }),
              },
            },
          ],
        });
      },
      grammar: "",
      profile: PLAIN_INSTRUCT_PROFILE,
      toolTransport: "native_tools",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
    });
    expect(outcome.terminal).toBe("turn");
    expect(capsSeen).toEqual([20_000, 20_000]);
    expect(capsSeen[1]).toBeGreaterThan(REPAIR_MAX_TOKENS);
  });

  it("native_tools: a repair that comes back cut off names the repair stage and its cap", async () => {
    const session = createEmptySessionState({
      id: "s-trunc-repair-cut",
      workingDir: "/w",
    });
    let calls = 0;
    await expect(
      executeStep(ctxFor(session), {
        registry: makeNativeRegistry(),
        slotManager: new SlotManager(2),
        async llmComplete() {
          calls += 1;
          if (calls === 1) {
            return nativeCompletion({
              reasoningContent: "I should reply now.",
            });
          }
          return nativeCompletion({
            reasoningContent: "Let me reconsider…",
            stop: false,
            truncated: true,
            finishReason: "length",
            usage: {
              promptTokens: 6_100,
              completionTokens: 16_384,
              totalTokens: 22_484,
            },
          });
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
      }),
    ).rejects.toMatchObject({
      name: "ModelError",
      reason: "truncated",
      stage: "repair",
      truncation: { cause: "reply_cap", requestedMaxTokens: 16_384 },
    });
  });

  it("native_tools: a cut with no cap on the wire is the provider's own limit, not our cap", async () => {
    // Request cloud-00312: no `max_tokens`, cut by the provider at 33,678
    // tokens, reported as "it spent the reply cap … of 8192" (the config
    // cap of the day; it is 16384 now, and must stay out of the message).
    const session = createEmptySessionState({
      id: "s-trunc-nocap",
      workingDir: "/w",
    });
    const error = await executeStep(ctxFor(session), {
      registry: makeNativeRegistry(),
      slotManager: new SlotManager(2),
      async llmComplete() {
        return nativeCompletion({
          reasoningContent: "Let me write every file out first…",
          stop: false,
          truncated: true,
          finishReason: "length",
          sentMaxTokens: null,
          usage: {
            promptTokens: 21_000,
            completionTokens: 33_678,
            totalTokens: 54_678,
          },
        });
      },
      grammar: "",
      profile: PLAIN_INSTRUCT_PROFILE,
      toolTransport: "native_tools",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toMatchObject({
      name: "ModelError",
      reason: "truncated",
      truncation: { cause: "provider_limit", completionTokens: 33_678 },
    });
    expect(
      (error as { truncation: Record<string, unknown> }).truncation,
    ).not.toHaveProperty("requestedMaxTokens");
    expect((error as Error).message).toContain(
      "the provider stopped at its own output limit after 33678 tokens (no reply cap was sent)",
    );
    expect((error as Error).message).not.toContain("16384");
    expect((error as Error).message).not.toContain("8192");
  });

  it("native_tools: judges a cut against the cap the provider reports it sent", async () => {
    // The step asked for nothing (config cap 16384), but the provider entry
    // carries a 12k ceiling — that is the cap the request ran under. Below
    // the config cap on purpose: judged against 16384 instead, a 12,288
    // reply would read as `context_window`, not `reply_cap`.
    const session = createEmptySessionState({
      id: "s-trunc-sent",
      workingDir: "/w",
    });
    await expect(
      executeStep(ctxFor(session), {
        registry: makeNativeRegistry(),
        slotManager: new SlotManager(2),
        async llmComplete() {
          return nativeCompletion({
            reasoningContent: "thinking…",
            stop: false,
            truncated: true,
            finishReason: "length",
            sentMaxTokens: 12_288,
            usage: {
              promptTokens: 6_000,
              completionTokens: 12_288,
              totalTokens: 18_288,
            },
          });
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
      }),
    ).rejects.toMatchObject({
      name: "ModelError",
      truncation: { cause: "reply_cap", requestedMaxTokens: 12_288 },
    });
  });
});

describe('strictTools wiring (supportsTools: "strict")', () => {
  // Two tools, one convertible and one not, so the per-tool half of the
  // contract is exercised in both directions of the same step.
  const convertible = {
    name: "acme.put",
    tier: "frequent" as const,
    summary: "store a value",
    argsSchema: "{ key: string, note?: string }",
    argsJsonSchema: {
      type: "object",
      properties: { key: { type: "string" }, note: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    } as Record<string, unknown>,
  };
  // Left open by its server, so closing it would forbid arguments it
  // accepts today: the converter refuses, and the function ships exactly
  // as it does with the level off — including its REQUIRED nullable.
  const refused = {
    name: "acme.raw",
    tier: "frequent" as const,
    summary: "store a raw value",
    argsSchema: "{ key: string, value: string | null }",
    argsJsonSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: ["string", "null"] },
      },
      required: ["key", "value"],
    } as Record<string, unknown>,
  };

  // Converts (it closes itself) AND has a required nullable next to an
  // optional one: the case where "the tool converted" and "this
  // argument was widened" come apart. Keyed per tool, the null-drop ate
  // `value` here on its way to the server.
  const convertedNullable = {
    name: "acme.mixed",
    tier: "frequent" as const,
    summary: "store a value that may legitimately be null",
    argsSchema: "{ key: string, value: string | null, note?: string }",
    argsJsonSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { anyOf: [{ type: "string" }, { type: "null" }] },
        note: { type: "string" },
      },
      required: ["key", "value"],
      additionalProperties: false,
    } as Record<string, unknown>,
  };

  // One call per step: a two-call batch is rejected before dispatch
  // because these invented tools carry no resource class.
  async function runStrictStep(
    call: { name: string; args: Record<string, unknown> } = {
      name: "acme__put",
      args: { key: "k", note: null },
    },
  ): Promise<{
    tools: ReadonlyArray<Record<string, unknown>>;
    argsSeen: Record<string, Record<string, unknown>>;
  }> {
    const argsSeen: Record<string, Record<string, unknown>> = {};
    const registry = new ToolRegistry();
    for (const name of [
      convertible.name,
      convertedNullable.name,
      refused.name,
    ]) {
      registry.register({
        name,
        description: name,
        readonly: true,
        async run(args: Record<string, unknown>) {
          argsSeen[name] = args;
          return compressToolResult({ tool: name, status: "ok", output: "ok" });
        },
      });
    }
    let tools: ReadonlyArray<Record<string, unknown>> = [];
    const outcome = await executeStep(
      {
        session: createEmptySessionState({ id: "s-strict", workingDir: "/w" }),
        toolDescriptors: [convertible, convertedNullable, refused],
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "store both",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        async llmComplete(params) {
          tools = (params.tools ?? []) as ReadonlyArray<
            Record<string, unknown>
          >;
          return {
            content: "",
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: 5,
            },
            cacheHitTokens: 0,
            slotId: -1,
            modelId: "mercury-2.5",
            toolCalls: [
              {
                id: "c1",
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args),
                },
              },
            ],
          };
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
        strictTools: true,
      },
    );
    expect(outcome.toolResults.every((r) => r.status === "ok")).toBe(true);
    return { tools, argsSeen };
  }

  it("marks only the convertible function strict on the wire", async () => {
    const { tools } = await runStrictStep();
    const byName = new Map(
      tools.map((t) => [
        (t as { function: { name: string } }).function.name,
        t as { function: { strict?: boolean } },
      ]),
    );
    expect(byName.get("acme__put")?.function.strict).toBe(true);
    expect(byName.get("acme__raw")?.function.strict).toBeUndefined();
  });

  it("undoes the null padding for that function and only that one", async () => {
    // Converted: the null is the schema's doing (an optional forced
    // into `required`), so the tool sees the absent key it would see
    // with the level off.
    const converted = await runStrictStep({
      name: "acme__put",
      args: { key: "k", note: null },
    });
    expect(converted.argsSeen["acme.put"]).toEqual({ key: "k" });
    // Refused: the null is the model's answer to the tool's OWN schema,
    // in which `value` is required and nullable. Deleting it would hand
    // the server a call missing a required key.
    const untouched = await runStrictStep({
      name: "acme__raw",
      args: { key: "k", value: null },
    });
    expect(untouched.argsSeen["acme.raw"]).toEqual({ key: "k", value: null });
  });

  it("keeps a required nullable argument of a function that converted", () => {
    // The undo is per ARGUMENT. `acme.mixed` converted — `note` was
    // widened — but `value` was already required and already nullable,
    // so it shipped byte-identical and its null is the model answering
    // the tool's own schema.
    return runStrictStep({
      name: "acme__mixed",
      args: { key: "k", value: null, note: null },
    }).then(({ tools, argsSeen }) => {
      const mixed = tools.find(
        (t) =>
          (t as { function: { name: string } }).function.name === "acme__mixed",
      ) as { function: { strict?: boolean } };
      expect(mixed.function.strict).toBe(true);
      expect(argsSeen["acme.mixed"]).toEqual({ key: "k", value: null });
    });
  });
});

describe("executeStep per-request grammar (F17)", () => {
  /**
   * The grammar rides with each request and is not part of the KV-cached
   * prefix, so a step can narrow what a local model may emit while the
   * prompt — descriptors included — stays byte-identical.
   */
  const grammarsDir = join(process.cwd(), "grammars");

  function makeRegistry() {
    const registry = new ToolRegistry();
    const define = (name: string, readonly: boolean) =>
      registry.register({
        name,
        description: name,
        readonly,
        async run(args) {
          return compressToolResult({
            tool: name,
            status: "ok",
            output: `${name} ${String(args.path ?? args.text ?? "")}`,
          });
        },
      });
    define("os.fs.read", true);
    define("os.fs.write", false);
    define("os.fs.edit", false);
    define("fusion.delegate", false);
    define("reply", true);
    define("finish", true);
    return registry;
  }

  async function runStep(
    ctxExtra: Partial<Parameters<typeof executeStep>[0]>,
    depsExtra: Partial<Parameters<typeof executeStep>[1]>,
  ) {
    const registry = makeRegistry();
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const session = createEmptySessionState({
      id: "s-grammar",
      workingDir: "/w",
    });
    const seen: LlmStreamParams[] = [];
    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
        ...ctxExtra,
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async (params) => {
          seen.push(params);
          return {
            content: JSON.stringify([
              { tool: "reply", args: { text: "done" } },
            ]),
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: 5,
            },
            cacheHitTokens: 0,
            slotId: 0,
            modelId: "mock",
          };
        },
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
        ...depsExtra,
      },
    );
    return { outcome, params: seen[0]!, baseGrammar: grammar };
  }

  it("sends the base grammar byte-identical when nothing narrows the step", async () => {
    const { params, baseGrammar } = await runStep({}, {});
    expect(params.grammar).toBe(baseGrammar);
    expect(grammarToolNames(params.grammar)).toBeNull();
  });

  it("final step: the grammar admits reply and finish only", async () => {
    const { params, baseGrammar } = await runStep({ terminalOnly: true }, {});
    expect(grammarToolNames(params.grammar)).toEqual(["finish", "reply"]);
    expect(params.grammar).not.toBe(baseGrammar);
  });

  it("orchestrator turn: the gate's refusals leave the grammar, their descriptors stay in the prompt", async () => {
    const { params } = await runStep(
      {},
      { isFusionOrchestrator: () => true },
    );
    const names = grammarToolNames(params.grammar);
    expect(names).not.toBeNull();
    // Refused: everything the gate would veto — the writes.
    expect(names).not.toContain("os.fs.write");
    expect(names).not.toContain("os.fs.edit");
    // Kept: reads, the fan-out, the terminals.
    expect(names).toContain("os.fs.read");
    expect(names).toContain("fusion.delegate");
    expect(names).toContain("reply");
    expect(names).toContain("finish");
    // D2: a refusal, not a hidden descriptor — the prompt still carries
    // the write tool in full, so the prefix bytes (and the KV cache)
    // are exactly those of a non-orchestrator step.
    expect(params.prompt).toContain("- os.fs.write —");
    const plain = await runStep({}, {});
    expect(params.prompt).toBe(plain.params.prompt);
  });

  it("worker turn: a toolFilter narrows the grammar, finish included", async () => {
    const hidden = new Set(["finish", "fusion.delegate", "tasks.schedule"]);
    const filter = (name: string) => !hidden.has(name);
    const { params } = await runStep(
      {
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS.filter((d) => filter(d.name)),
        toolFilter: filter,
      },
      {},
    );
    const names = grammarToolNames(params.grammar);
    expect(names).not.toBeNull();
    for (const name of hidden) expect(names).not.toContain(name);
    expect(names).toContain("os.fs.write");
    expect(names).toContain("reply");
  });

  it("the repair retry goes out under the same narrowed grammar", async () => {
    const registry = makeRegistry();
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const session = createEmptySessionState({ id: "s-g-repair", workingDir: "/w" });
    const seen: LlmStreamParams[] = [];
    let calls = 0;
    await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
        terminalOnly: true,
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async (params) => {
          seen.push(params);
          calls += 1;
          return {
            content:
              calls === 1
                ? "not json at all"
                : JSON.stringify([{ tool: "reply", args: { text: "ok" } }]),
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: { promptMs: 1, predictedMs: 1, promptTokens: 1, predictedTokens: 1 },
            cacheHitTokens: 0,
            slotId: 0,
            modelId: "mock",
          };
        },
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
      },
    );
    expect(seen).toHaveLength(2);
    expect(grammarToolNames(seen[1]!.grammar)).toEqual(["finish", "reply"]);
  });
});

describe("executeStep tool roles (F18)", () => {
  const grammarsDir = join(process.cwd(), "grammars");

  function makeRegistry() {
    const registry = new ToolRegistry();
    for (const [name, readonly] of [
      ["os.fs.read", true],
      ["os.fs.write", false],
      ["tasks.schedule", false],
      ["reply", true],
      ["finish", true],
    ] as const) {
      registry.register({
        name,
        description: name,
        readonly,
        async run(args) {
          return compressToolResult({
            tool: name,
            status: "ok",
            output: `${name} ${String(args.path ?? args.text ?? "")}`,
          });
        },
      });
    }
    return registry;
  }

  async function runStep(
    ctxExtra: Partial<Parameters<typeof executeStep>[0]>,
    depsExtra: Partial<Parameters<typeof executeStep>[1]>,
  ) {
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const seen: LlmStreamParams[] = [];
    await executeStep(
      {
        session: createEmptySessionState({ id: "s-role", workingDir: "/w" }),
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
        ...ctxExtra,
      },
      {
        registry: makeRegistry(),
        slotManager: new SlotManager(2),
        llmComplete: async (params) => {
          seen.push(params);
          return {
            content: JSON.stringify([{ tool: "reply", args: { text: "ok" } }]),
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: { promptMs: 1, predictedMs: 1, promptTokens: 1, predictedTokens: 1 },
            cacheHitTokens: 0,
            slotId: 0,
            modelId: "mock",
          };
        },
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
        ...depsExtra,
      },
    );
    return { params: seen[0]!, baseGrammar: grammar };
  }

  const wireNames = (params: LlmStreamParams): string[] =>
    (params.tools ?? []).map(
      (t) => (t as { function?: { name?: string } }).function?.name ?? "",
    );

  it("builder on native tools: only the role's schemas go on the wire, plus what is loaded", async () => {
    const session = createEmptySessionState({ id: "s-role-w", workingDir: "/w" });
    session.loadedTools = [
      {
        name: "tasks.schedule",
        summary: "Schedule.",
        argsSchema: "{}",
        loadedAt: 1,
        source: "explicit",
      },
    ];
    const { params } = await runStep(
      { toolRole: "builder", session },
      { toolTransport: "native_tools", toolCallAdapter: null, supportsSlotAffinity: false },
    );
    const names = wireNames(params);
    expect(names).toContain("os__fs__write");
    expect(names).toContain("os__shell__run");
    expect(names).toContain("reply");
    // Loaded from outside the role: on the wire and callable.
    expect(names).toContain("tasks__schedule");
    // Outside the role and not loaded: name only, in the prompt.
    expect(names).not.toContain("tasks__cron");
    expect(names).not.toContain("browser__navigate");
    expect(params.prompt).toContain("# also available via `tool.view`:");
    expect(params.prompt).not.toContain("- browser.navigate —");
    // Described once per transport: the wire has the schema, the prompt
    // has the full text for the role's tools only.
    expect(params.prompt).toContain("- os.fs.write —");
  });

  it("builder on the grammar transport: the grammar admits the role's names plus the loaded ones", async () => {
    const session = createEmptySessionState({ id: "s-role-g", workingDir: "/w" });
    session.loadedTools = [
      {
        name: "tasks.schedule",
        summary: "Schedule.",
        argsSchema: "{}",
        loadedAt: 1,
        source: "explicit",
      },
    ];
    const { params, baseGrammar } = await runStep({ toolRole: "builder", session }, {});
    expect(params.grammar).not.toBe(baseGrammar);
    const names = grammarToolNames(params.grammar);
    expect(names).not.toBeNull();
    expect(names).toContain("os.fs.write");
    expect(names).toContain("os.shell.run");
    expect(names).toContain("reply");
    expect(names).toContain("tasks.schedule");
    expect(names).not.toContain("tasks.cron");
    expect(names).not.toContain("finish");
    expect(names).not.toContain("browser.navigate");
  });

  it("orchestrator role + gate: a loaded write is on the wire's descriptors but never in the grammar", async () => {
    const session = createEmptySessionState({ id: "s-role-o", workingDir: "/w" });
    session.loadedTools = [
      {
        name: "os.fs.write",
        summary: "Write.",
        argsSchema: "{}",
        loadedAt: 1,
        source: "explicit",
      },
    ];
    const { params } = await runStep(
      { toolRole: "orchestrator", session },
      { isFusionOrchestrator: () => true },
    );
    const names = grammarToolNames(params.grammar);
    expect(names).toContain("os.fs.read");
    expect(names).toContain("reply");
    expect(names).toContain("finish");
    // Loaded, but the gate would refuse it — so the grammar drops it.
    expect(names).not.toContain("os.fs.write");
    expect(params.prompt).toContain("Write.");
  });

  it("full role is byte-identical to no role, prompt and grammar alike", async () => {
    const a = await runStep({ toolRole: "full" }, {});
    const b = await runStep({}, {});
    expect(a.params.prompt).toBe(b.params.prompt);
    expect(a.params.grammar).toBe(a.baseGrammar);
    expect(b.params.grammar).toBe(b.baseGrammar);
  });
});

describe("executeStep — the structured prompt on a native-tools link", () => {
  const completion = (toolCalls?: CompletionResult["toolCalls"]): CompletionResult => ({
    content: "",
    reasoningContent: toolCalls ? "" : "thinking only",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 20, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: -1,
    modelId: "openai/gpt-5.5",
    ...(toolCalls ? { toolCalls } : {}),
  });
  const replyCall: CompletionResult["toolCalls"] = [
    { id: "c", type: "function", function: { name: "reply", arguments: JSON.stringify({ text: "ok" }) } },
  ];

  async function run(toolTransport: ToolCallTransport, answers: CompletionResult[]) {
    const registry = new ToolRegistry();
    registry.register(replyTool);
    const base = createEmptySessionState({ id: `s-messages-${toolTransport}`, workingDir: "/w" });
    const session = { ...base, turns: [{ kind: "user" as const, text: "hi", at: 1 }] };
    const seen: Array<Parameters<NonNullable<Parameters<typeof executeStep>[1]["llmComplete"]>>[0]> = [];
    let call = 0;
    const grammar =
      toolTransport === "grammar"
        ? await buildGrammar(PLAIN_INSTRUCT_PROFILE, join(process.cwd(), "grammars"))
        : "";
    await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "hi",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        async llmComplete(params) {
          seen.push(params);
          const answer = answers[Math.min(call, answers.length - 1)]!;
          call += 1;
          return answer;
        },
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport,
        toolCallAdapter: null,
        supportsSlotAffinity: toolTransport === "grammar",
      },
    );
    return seen;
  }

  it("carries `messages` beside the flat prompt, built from the same packed conversation", async () => {
    const [params] = await run("native_tools", [completion(replyCall)]);
    expect(params?.messages).toBeDefined();
    expect(params?.messages?.system).toBe(params?.prompt.slice(0, params.messages.system.length));
    expect(params?.messages?.turns).toEqual([{ kind: "user", text: "hi" }]);
    expect(params?.messages?.tail).not.toContain("### conversation");
    expect(params?.prompt).toContain("### conversation\nuser: hi");
  });

  it("re-shapes the structured tail for the one-shot repair, notice included", async () => {
    const seen = await run("native_tools", [completion(), completion(replyCall)]);
    expect(seen).toHaveLength(2);
    const repair = seen[1]!;
    expect(repair.prompt).toContain("### tool-call-repair");
    expect(repair.messages?.tail).toContain("### tool-call-repair");
    expect(repair.messages?.tail).toContain("native function-calling interface");
    expect(repair.messages?.system).toBe(seen[0]!.messages?.system);
    expect(repair.messages?.turns).toEqual(seen[0]!.messages?.turns);
  });

  it("sends none on the grammar transport", async () => {
    const grammarAnswer: CompletionResult = {
      ...completion(),
      reasoningContent: "",
      content: JSON.stringify([{ tool: "reply", args: { text: "ok" } }]),
    };
    const [params] = await run("grammar", [grammarAnswer]);
    expect(params).not.toHaveProperty("messages");
  });
});

describe("batch trim consults the turn policy (F8)", () => {
  // Run 14, attempt 0, first step: the orchestrator emitted
  // `[os.shell.run mkdir, fusion.delegate]`. The trim kept `mkdir` (first
  // approval-gated call in emit order), the fusion gate then refused it,
  // and the delegation — nine minutes of generation — was dropped for a
  // retry. The survivor must be a call that can run.
  const grammarsDir = join(process.cwd(), "grammars");

  function makeRegistry() {
    const registry = new ToolRegistry();
    const define = (name: string, readonly: boolean) =>
      registry.register({
        name,
        description: name,
        readonly,
        async run(args) {
          return compressToolResult({
            tool: name,
            status: "ok",
            output: `${name} ran (${JSON.stringify(args)})`,
          });
        },
      });
    define("os.fs.read", true);
    define("os.fs.write", false);
    define("os.fs.edit", false);
    define("os.shell.run", false);
    define("fusion.delegate", false);
    return registry;
  }

  async function run(
    body: string,
    policy: { isPlanMode?: () => boolean; isFusionOrchestrator?: () => boolean },
  ) {
    const events: StepEvent[] = [];
    const registry = makeRegistry();
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const session = createEmptySessionState({ id: "s-f8", workingDir: "/w" });
    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
      },
      {
        registry,
        ...policy,
        ...(policy.isFusionOrchestrator
          ? { fusionState: () => ({ delegations: 0 }) }
          : {}),
        slotManager: new SlotManager(2),
        llmComplete: async () => ({
          content: body,
          reasoningContent: "",
          stop: true,
          truncated: false,
          timing: { promptMs: 1, predictedMs: 1, promptTokens: 20, predictedTokens: 5 },
          cacheHitTokens: 0,
          slotId: 0,
          modelId: "mock",
        }),
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
        onEvent: (ev) => events.push(ev),
      },
    );
    return { outcome, events };
  }

  it("keeps fusion.delegate on an orchestrator turn and names the refused call", async () => {
    const body = JSON.stringify([
      { tool: "os.shell.run", args: { cmd: "mkdir", args: ["-p", "js"] } },
      {
        tool: "fusion.delegate",
        args: { tasks: [{ id: "a", title: "t", instructions: "i" }] },
      },
    ]);
    const { outcome, events } = await run(body, {
      isFusionOrchestrator: () => true,
    });
    expect(outcome.toolCalls.map((c) => c.tool)).toEqual(["fusion.delegate"]);
    expect(outcome.toolResults[0]!.status).toBe("ok");
    const trim = events.find((e) => e.type === "batch_trimmed");
    expect(trim).toMatchObject({
      kept: "fusion.delegate",
      dropped: [],
      refused: ["os.shell.run"],
    });
    expect(outcome.trimmedBatchNotice).toContain("`os.shell.run`");
    expect(outcome.trimmedBatchNotice).toContain("refused by the fusion gate");
    expect(outcome.trimmedBatchNotice).toContain("do not retry");
    expect(outcome.trimmedBatchNotice).not.toContain("Dropped from the batch — retry");
  });

  it("prefers the fan-out over an earlier runnable write on an orchestrator turn", async () => {
    // Even a call the gate would not refuse (none here — both mutate —
    // but the preference is what is under test) yields to the fan-out.
    const trim = trimBatchToFirstApprovalGated(
      {
        kind: "batch",
        calls: [
          { tool: "os.fs.read", args: { path: "a" } },
          { tool: "fusion.delegate", args: { tasks: [] } },
          { tool: "os.fs.write", args: { path: "b", content: "" } },
        ],
      },
      { preferTool: "fusion.delegate" },
    );
    expect(trim?.kept.tool).toBe("fusion.delegate");
    expect(trim?.dropped.map((c) => c.tool)).toEqual(["os.fs.read", "os.fs.write"]);
    expect(trim?.refused).toEqual([]);
  });

  it("falls back to the first gated call when every gated call would be refused", async () => {
    // Plan mode: `[write, edit, read]`. Nothing gated can run; the first
    // is kept so the gate's own refusal — the instruction — is what the
    // model reads, the second is named as refused, the read as a retry.
    const body = JSON.stringify([
      { tool: "os.fs.write", args: { path: "a", content: "x" } },
      { tool: "os.fs.edit", args: { path: "b", oldString: "x", newString: "y" } },
      { tool: "os.fs.read", args: { path: "c" } },
    ]);
    const { outcome, events } = await run(body, { isPlanMode: () => true });
    expect(outcome.toolCalls.map((c) => c.tool)).toEqual(["os.fs.write"]);
    expect(outcome.toolResults[0]!.status).toBe("error");
    expect(outcome.toolResults[0]!.details).toMatchObject({ plan_mode: true });
    expect(events.find((e) => e.type === "batch_trimmed")).toMatchObject({
      kept: "os.fs.write",
      dropped: ["os.fs.read"],
      refused: ["os.fs.edit"],
    });
    expect(outcome.trimmedBatchNotice).toContain("`os.fs.edit` (refused by plan mode)");
    expect(outcome.trimmedBatchNotice).toContain("Dropped from the batch — retry: `os.fs.read`");
  });

  it("is byte-identical to the old trim when no policy is active", async () => {
    const body = JSON.stringify([
      { tool: "os.fs.write", args: { path: "a", content: "x" } },
      { tool: "os.fs.edit", args: { path: "b", oldString: "x", newString: "y" } },
    ]);
    const { outcome, events } = await run(body, {});
    expect(outcome.toolCalls.map((c) => c.tool)).toEqual(["os.fs.write"]);
    const trim = events.find((e) => e.type === "batch_trimmed");
    expect(trim).toMatchObject({ kept: "os.fs.write", dropped: ["os.fs.edit"] });
    expect(trim).not.toHaveProperty("refused");
    expect(outcome.trimmedBatchNotice).not.toContain("refused");
  });

  it("turnPolicyForTrim names the gate that would refuse, plan mode first", () => {
    const registry = makeRegistry();
    const both = turnPolicyForTrim({
      registry,
      isPlanMode: () => true,
      isFusionOrchestrator: () => true,
    });
    expect(both.preferTool).toBe("fusion.delegate");
    expect(both.refusedBy?.("os.fs.write")).toBe(TRIM_REFUSED_BY_PLAN_MODE);
    expect(both.refusedBy?.("os.fs.read")).toBeNull();
    expect(both.refusedBy?.("fusion.delegate")).toBe(TRIM_REFUSED_BY_PLAN_MODE);
    const orchestrator = turnPolicyForTrim({
      registry,
      isFusionOrchestrator: () => true,
    });
    expect(orchestrator.refusedBy?.("os.shell.run")).toBe(TRIM_REFUSED_BY_FUSION_GATE);
    expect(orchestrator.refusedBy?.("fusion.delegate")).toBeNull();
    expect(turnPolicyForTrim({ registry })).toEqual({});
  });
});

describe("claims need evidence (F9b)", () => {
  // A reply that says a check ran, with no matching call this turn, is
  // held back once with a notice; the second time it is delivered and
  // marked. The forced final step never holds a reply.
  const grammarsDir = join(process.cwd(), "grammars");

  function makeRegistry() {
    const registry = new ToolRegistry();
    registry.register({
      name: "os.shell.run",
      description: "shell",
      readonly: false,
      async run(args) {
        return compressToolResult({
          tool: "os.shell.run",
          status: "ok",
          output: `$ ${String(args.cmd)}\nexit: 0`,
        });
      },
    });
    registry.register(replyTool);
    return registry;
  }

  async function run(
    body: string,
    options: {
      turns?: Array<{ tool: string; args: Record<string, unknown> }>;
      noticed?: boolean;
      terminalOnly?: boolean;
      claimEvidence?: false;
    } = {},
  ) {
    const registry = makeRegistry();
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const session = createEmptySessionState({ id: "s-f9", workingDir: "/w" });
    session.turns.push({ kind: "user", text: "check the files", at: 1 });
    for (const call of options.turns ?? []) {
      session.turns.push({ kind: "assistant_tool_call", ...call, at: 2 });
      session.turns.push({ kind: "tool_result", tool: call.tool, status: "ok", summary: "ok", at: 3 });
    }
    let noticed = options.noticed ?? false;
    let marks = 0;
    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "check the files",
        ...(options.terminalOnly ? { terminalOnly: true } : {}),
      },
      {
        registry,
        ...(options.claimEvidence === false
          ? {}
          : {
              claimEvidence: {
                noticed: () => noticed,
                markNoticed: () => {
                  noticed = true;
                  marks += 1;
                },
              },
            }),
        slotManager: new SlotManager(2),
        llmComplete: async () => ({
          content: body,
          reasoningContent: "",
          stop: true,
          truncated: false,
          timing: { promptMs: 1, predictedMs: 1, promptTokens: 20, predictedTokens: 5 },
          cacheHitTokens: 0,
          slotId: 0,
          modelId: "mock",
        }),
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
      },
    );
    return { outcome, marks: () => marks };
  }

  const CLAIM = JSON.stringify([
    { tool: "reply", args: { text: "Ran node --check on all JavaScript files (all passed)." } },
  ]);

  it("holds a reply that claims a check nothing ran, once, with a notice", async () => {
    const { outcome, marks } = await run(CLAIM);
    expect(outcome.terminal).toBeNull();
    expect(outcome.toolCalls.map((c) => c.tool)).toEqual(["reply"]);
    expect(outcome.toolResults[0]!.status).toBe("error");
    expect(outcome.toolResults[0]!.summary).toContain("not delivered");
    expect(outcome.toolResults[0]!.details).toMatchObject({
      notDelivered: true,
      unverifiedClaims: ["node --check"],
    });
    expect(outcome.trimmedBatchNotice).toContain('Your reply claims "node --check"');
    expect(outcome.trimmedBatchNotice).toContain("no such check ran this turn");
    expect(marks()).toBe(1);
    // The transcript reads the held reply as a call that never delivered.
    const last = outcome.nextSession.turns[outcome.nextSession.turns.length - 1];
    expect(last?.kind).toBe("tool_result");
  });

  it("delivers the reply when a shell call this turn ran the claimed check", async () => {
    const { outcome, marks } = await run(CLAIM, {
      turns: [{ tool: "os.shell.run", args: { cmd: "node", args: ["--check", "js/a.js"] } }],
    });
    expect(outcome.terminal).toBe("turn");
    expect(outcome.toolResults[0]!.status).toBe("ok");
    expect(outcome.toolResults[0]!.details).not.toHaveProperty("unverifiedClaims");
    expect(outcome.trimmedBatchNotice).toBeUndefined();
    expect(marks()).toBe(0);
  });

  it("delivers a second claiming reply and marks it in the result details", async () => {
    const { outcome, marks } = await run(CLAIM, { noticed: true });
    expect(outcome.terminal).toBe("turn");
    expect(outcome.toolResults[0]!.status).toBe("ok");
    expect(outcome.toolResults[0]!.details).toMatchObject({
      unverifiedClaims: ["node --check"],
    });
    expect(marks()).toBe(0);
  });

  it("never holds the forced final step's reply, but marks it", async () => {
    const { outcome, marks } = await run(CLAIM, { terminalOnly: true });
    expect(outcome.terminal).toBe("turn");
    expect(outcome.toolResults[0]!.details).toMatchObject({
      unverifiedClaims: ["node --check"],
    });
    expect(marks()).toBe(0);
  });

  it("does nothing when the loop passes no claim state", async () => {
    const { outcome } = await run(CLAIM, { claimEvidence: false });
    expect(outcome.terminal).toBe("turn");
    expect(outcome.toolResults[0]!.details).not.toHaveProperty("unverifiedClaims");
  });
});

describe("the operator's request reaches the prompt (F22)", () => {
  it("renders ### request when the step context carries it and the packer dropped its turn", async () => {
    const grammarsDir = join(process.cwd(), "grammars");
    const registry = new ToolRegistry();
    registry.register(replyTool);
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const spec = `Build it: ${"detail ".repeat(30_000)}`;
    const session = createEmptySessionState({ id: "s-f22", workingDir: "/w" });
    session.turns.push({ kind: "user", text: spec, at: 1 });
    session.turns.push({ kind: "assistant_reply", text: "built", at: 2 });
    session.turns.push({ kind: "user", text: "fix these bugs", at: 3 });
    const run = (originalRequest?: string) =>
      executeStep(
        {
          session,
          toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
          capabilities: CAPS,
          skillCatalog: SKILLS,
          stepIndex: 0,
          signal: new AbortController().signal,
          userMessage: "fix these bugs",
          ...(originalRequest === undefined ? {} : { originalRequest }),
        },
        {
          registry,
          slotManager: new SlotManager(2),
          llmComplete: async () => ({
            content: JSON.stringify([{ tool: "reply", args: { text: "ok" } }]),
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: { promptMs: 1, predictedMs: 1, promptTokens: 20, predictedTokens: 5 },
            cacheHitTokens: 0,
            slotId: 0,
            modelId: "mock",
          }),
          grammar,
          profile: PLAIN_INSTRUCT_PROFILE,
        },
      );
    const pinned = await run(spec);
    expect(pinned.prompt.droppedTurns).toBeGreaterThan(0);
    expect(pinned.prompt.tail).toContain("### request");
    expect(pinned.prompt.tail.indexOf("### request")).toBeLessThan(
      pinned.prompt.tail.indexOf("### conversation"),
    );
    const bare = await run();
    expect(bare.prompt.tail).not.toContain("### request");
  });
});

describe("the turn's reasoning effort and output ceiling reach the request (F20)", () => {
  it("rides on llmParams from the step context; the per-step cap still wins", async () => {
    const grammarsDir = join(process.cwd(), "grammars");
    const registry = new ToolRegistry();
    registry.register(replyTool);
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const seen: Array<{ reasoningEffort?: string; maxOutputTokens?: number; maxTokens?: number }> = [];
    const run = (over: { reasoningEffort?: "low"; maxOutputTokens?: number; maxTokens?: number }) =>
      executeStep(
        {
          session: createEmptySessionState({ id: "s-f20", workingDir: "/w" }),
          toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
          capabilities: CAPS,
          skillCatalog: SKILLS,
          stepIndex: 0,
          signal: new AbortController().signal,
          userMessage: "x",
          ...over,
        },
        {
          registry,
          slotManager: new SlotManager(2),
          llmComplete: async (params) => {
            seen.push({
              ...(params.reasoningEffort === undefined ? {} : { reasoningEffort: params.reasoningEffort }),
              ...(params.maxOutputTokens === undefined ? {} : { maxOutputTokens: params.maxOutputTokens }),
              ...(params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens }),
            });
            return {
              content: JSON.stringify([{ tool: "reply", args: { text: "ok" } }]),
              reasoningContent: "",
              stop: true,
              truncated: false,
              timing: { promptMs: 1, predictedMs: 1, promptTokens: 20, predictedTokens: 5 },
              cacheHitTokens: 0,
              slotId: 0,
              modelId: "mock",
            };
          },
          grammar,
          profile: PLAIN_INSTRUCT_PROFILE,
        },
      );
    await run({ reasoningEffort: "low", maxOutputTokens: 12_000 });
    await run({ maxOutputTokens: 12_000, maxTokens: 32_000 });
    await run({});
    expect(seen).toEqual([
      { reasoningEffort: "low", maxOutputTokens: 12_000 },
      { maxOutputTokens: 12_000, maxTokens: 32_000 },
      {},
    ]);
  });
});

describe("executeStep — server chat template parts (F31)", () => {
  const grammarsDir = join(process.cwd(), "grammars");

  function registryWithReply(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      name: "reply",
      description: "reply",
      readonly: true,
      async run(args: Record<string, unknown>) {
        return compressToolResult({
          tool: "reply",
          status: "ok",
          output: String(args.text ?? ""),
        });
      },
    });
    return registry;
  }

  async function runWith(profile: typeof PLAIN_PROFILE_F31 | typeof QWEN_PROFILE_F31) {
    const grammar = await buildGrammar(profile, grammarsDir);
    const seen: Array<Record<string, unknown>> = [];
    await executeStep(
      {
        session: createEmptySessionState({ id: "s-f31", workingDir: "/w" }),
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "hello",
      },
      {
        registry: registryWithReply(),
        slotManager: new SlotManager(2),
        toolTransport: "grammar",
        llmComplete: async (params) => {
          seen.push(params as unknown as Record<string, unknown>);
          return {
            content: JSON.stringify({ tool: "reply", args: { text: "hi" } }),
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: { promptMs: 1, predictedMs: 1, promptTokens: 20, predictedTokens: 5 },
            cacheHitTokens: 0,
            slotId: 0,
            modelId: "mock",
          };
        },
        grammar,
        profile,
      },
    );
    return seen[0]!;
  }

  it("hands a plain-instruct link the prefix and a framing-free tail as chat parts (auto)", async () => {
    const params = await runWith(PLAIN_PROFILE_F31);
    const chat = params.chat as { system: string; user: string; prefixHash: string };
    expect(chat).toBeDefined();
    expect(chat.system.startsWith("### system")).toBe(true);
    expect(chat.user).toContain("### respond");
    expect(chat.prefixHash).toMatch(/^[0-9a-f]+$/);
    // The raw text still travels for a link that cannot render.
    expect(params.prompt).toBe(`${chat.system}\n${chat.user}`);
    expect(params.grammar).toContain("root");
  });

  it("keeps the hand-built framing and sends no chat parts for a qwen link (auto)", async () => {
    const params = await runWith(QWEN_PROFILE_F31);
    expect(params.chat).toBeUndefined();
    expect((params.prompt as string).trimEnd().endsWith("<think>")).toBe(true);
  });
});

describe("executeStep slot pinning (F13)", () => {
  const grammarsDir = join(process.cwd(), "grammars");

  function replyRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      name: "reply",
      description: "reply",
      readonly: true,
      async run(args: Record<string, unknown>) {
        return compressToolResult({
          tool: "reply",
          status: "ok",
          output: String(args.text ?? ""),
        });
      },
    });
    return registry;
  }

  const replyBody = JSON.stringify([{ tool: "reply", args: { text: "ok" } }]);

  it("sends a pending session's first request as id_slot -1 WITH cache_prompt, then pins the server's answer", async () => {
    const registry = replyRegistry();
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const slotManager = new SlotManager(4);
    const seen: Array<{ slotId: number; cachePrompt: boolean | undefined }> = [];
    const deps = {
      registry,
      slotManager,
      llmComplete: async (params: { slotId: number; cachePrompt?: boolean }) => {
        seen.push({ slotId: params.slotId, cachePrompt: params.cachePrompt });
        // llama-server picked slot 2 by prefix similarity.
        return mockCompletion(replyBody, { slotId: 2 });
      },
      grammar,
      profile: PLAIN_INSTRUCT_PROFILE,
      supportsSlotAffinity: true,
    };
    let session = createEmptySessionState({ id: "s-pin", workingDir: "/w" });
    const first = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
      },
      deps,
    );
    session = first.nextSession;
    expect(seen[0]).toEqual({ slotId: -1, cachePrompt: true });
    expect(slotManager.pinnedSlot("s-pin")).toBe(2);

    await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 1,
        signal: new AbortController().signal,
      },
      deps,
    );
    // The retry of a later step names the pinned slot.
    expect(seen[1]).toEqual({ slotId: 2, cachePrompt: true });
  });

  it("stays pending when the server did not name a slot, and asks again next step", async () => {
    const registry = replyRegistry();
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const slotManager = new SlotManager(4);
    const slots: number[] = [];
    const deps = {
      registry,
      slotManager,
      llmComplete: async (params: { slotId: number }) => {
        slots.push(params.slotId);
        return mockCompletion(replyBody, { slotId: -1 });
      },
      grammar,
      profile: PLAIN_INSTRUCT_PROFILE,
      supportsSlotAffinity: true,
    };
    const ctx = {
      toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      signal: new AbortController().signal,
    };
    let session = createEmptySessionState({ id: "s-nopin", workingDir: "/w" });
    session = (
      await executeStep({ ...ctx, session, stepIndex: 0, userMessage: "x" }, deps)
    ).nextSession;
    await executeStep({ ...ctx, session, stepIndex: 1 }, deps);
    expect(slots).toEqual([-1, -1]);
    expect(slotManager.pinnedSlot("s-nopin")).toBeNull();
  });

  it("runs the in-step repair on the slot the first completion was pinned to", async () => {
    const registry = replyRegistry();
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const slotManager = new SlotManager(4);
    const slots: number[] = [];
    const deps = {
      registry,
      slotManager,
      llmComplete: async (params: { slotId: number }) => {
        slots.push(params.slotId);
        return slots.length === 1
          ? // Unparseable, so the executor issues its one-shot repair.
            mockCompletion("this is not a tool call", { slotId: 3 })
          : mockCompletion(replyBody, { slotId: 3 });
      },
      grammar,
      profile: PLAIN_INSTRUCT_PROFILE,
      supportsSlotAffinity: true,
    };
    const outcome = await executeStep(
      {
        session: createEmptySessionState({ id: "s-repair", workingDir: "/w" }),
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
      },
      deps,
    );
    expect(outcome.toolResults[0]!.tool).toBe("reply");
    expect(slots).toEqual([-1, 3]);
    expect(slotManager.pinnedSlot("s-repair")).toBe(3);
  });

  it("keeps the pinned slot across a stable-prefix change instead of rotating", async () => {
    const registry = replyRegistry();
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const slotManager = new SlotManager(4);
    slotManager.pin("s-prefix", 1, "stale-hash");
    const slots: number[] = [];
    const cacheReused: boolean[] = [];
    await executeStep(
      {
        session: createEmptySessionState({ id: "s-prefix", workingDir: "/w" }),
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
      },
      {
        registry,
        slotManager,
        llmComplete: async (params: { slotId: number }) => {
          slots.push(params.slotId);
          return mockCompletion(replyBody, { slotId: 1 });
        },
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
        supportsSlotAffinity: true,
        onEvent: (event: StepEvent) => {
          if (event.type === "prompt_captured") cacheReused.push(event.cacheReused);
        },
      },
    );
    expect(slots).toEqual([1]);
    // Honest about the changed prefix, but the slot did not move.
    expect(cacheReused).toEqual([false]);
    expect(slotManager.pinnedSlot("s-prefix")).toBe(1);
  });

  it("never sets cache_prompt or pins on a link without slot affinity", async () => {
    const registry = replyRegistry();
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const slotManager = new SlotManager(4);
    const seen: Array<{ slotId: number; cachePrompt: boolean | undefined }> = [];
    await executeStep(
      {
        session: createEmptySessionState({ id: "s-cloud", workingDir: "/w" }),
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
      },
      {
        registry,
        slotManager,
        llmComplete: async (params: { slotId: number; cachePrompt?: boolean }) => {
          seen.push({ slotId: params.slotId, cachePrompt: params.cachePrompt });
          return mockCompletion(replyBody, { slotId: 5 });
        },
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
        supportsSlotAffinity: false,
      },
    );
    expect(seen).toEqual([{ slotId: -1, cachePrompt: undefined }]);
    expect(slotManager.pinnedSlot("s-cloud")).toBeNull();
  });
});

describe("executeStep reasoning budget and thinking: off (F49)", () => {
  const grammarsDir = join(process.cwd(), "grammars");
  const CALL = JSON.stringify([{ tool: "reply", args: { text: "done" } }]);

  function makeRegistry() {
    const registry = new ToolRegistry();
    for (const [name, readonly] of [
      ["os.fs.read", true],
      ["reply", true],
      ["finish", true],
    ] as const) {
      registry.register({
        name,
        description: name,
        readonly,
        async run(args) {
          return compressToolResult({
            tool: name,
            status: "ok",
            output: `${name} ${String(args.text ?? "")}`,
          });
        },
      });
    }
    return registry;
  }

  /** Run one step on a qwen grammar; `bodies` are the raw completions in order. */
  async function runQwen(
    bodies: string[],
    ctxExtra: Partial<Parameters<typeof executeStep>[0]> = {},
    budgetTokens?: number,
  ) {
    const grammar = await buildGrammar(
      QWEN_THINK_PROFILE,
      grammarsDir,
      budgetTokens === undefined ? {} : { reasoningBudgetTokens: budgetTokens },
    );
    const session = createEmptySessionState({ id: "s-f49", workingDir: "/w" });
    const seen: LlmStreamParams[] = [];
    const events: StepEvent[] = [];
    let calls = 0;
    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
        ...ctxExtra,
      },
      {
        registry: makeRegistry(),
        slotManager: new SlotManager(2),
        llmComplete: async (params) => {
          seen.push(params);
          const content = bodies[calls] ?? bodies[bodies.length - 1]!;
          calls += 1;
          return {
            content,
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: { promptMs: 1, predictedMs: 1, promptTokens: 20, predictedTokens: 5 },
            cacheHitTokens: 0,
            slotId: 0,
            modelId: "mock",
          };
        },
        grammar,
        profile: QWEN_THINK_PROFILE,
        onEvent: (event) => {
          events.push(event);
        },
      },
    );
    return { outcome, seen, events, baseGrammar: grammar };
  }

  /** Point the config at a temp state dir holding `localModels`; returns the restore. */
  function withLocalModelsConfig(localModels: Record<string, unknown>): () => void {
    const previous = process.env.ATOMIC_AGENT_STATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), "f49-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ localModels }));
    process.env.ATOMIC_AGENT_STATE_DIR = dir;
    resetConfigCache();
    return () => {
      if (previous === undefined) delete process.env.ATOMIC_AGENT_STATE_DIR;
      else process.env.ATOMIC_AGENT_STATE_DIR = previous;
      resetConfigCache();
    };
  }

  it("an ordinary step sends the bounded prelude byte-identical to the base grammar", async () => {
    const { seen, baseGrammar } = await runQwen([`thinking</think>\n${CALL}`], {}, 2);
    expect(seen[0]!.grammar).toBe(baseGrammar);
    expect(seen[0]!.grammar).toContain("think-body ::= think-char{0,8}");
  });

  it("the forced final step lifts the bound: a reply or finish is never cut mid-thought", async () => {
    const { seen, baseGrammar } = await runQwen(
      [`thinking</think>\n${CALL}`],
      { terminalOnly: true },
      2,
    );
    expect(seen[0]!.grammar).not.toBe(baseGrammar);
    expect(seen[0]!.grammar).toContain("think-body ::= think-char*");
    expect(seen[0]!.grammar).not.toContain("think-char{0,8}");
    expect(grammarToolNames(seen[0]!.grammar)).toEqual(["finish", "reply"]);
    expect(seen[0]!.grammar).toMatch(/^root ::= think-prelude tool-call-array$/m);
  });

  it("llm_raw_completion carries the reasoning estimate in budget units, so a cut reads as >= budget", async () => {
    const reasoning = "x".repeat(8);
    const { events } = await runQwen([`${reasoning}</think>\n${CALL}`], {}, 2);
    const raw = events.find((e) => e.type === "llm_raw_completion");
    expect(raw).toMatchObject({ type: "llm_raw_completion", attempt: 1, reasoningTokens: 2 });
    const reasoningEvent = events.find((e) => e.type === "reasoning");
    expect(reasoningEvent).toMatchObject({ type: "reasoning", text: reasoning });
  });

  it("thinking: off — the prompt ends with the disabled marker, the grammar has the plain root, the call parses with no reasoning", async () => {
    const restore = withLocalModelsConfig({ thinking: "off" });
    try {
      const { outcome, seen, events, baseGrammar } = await runQwen([CALL]);
      expect(seen[0]!.prompt.endsWith("<think>\n\n</think>\n\n")).toBe(true);
      expect(seen[0]!.grammar).not.toBe(baseGrammar);
      expect(seen[0]!.grammar).toMatch(/^root ::= tool-call-array$/m);
      expect(seen[0]!.grammar).not.toMatch(/^root ::= think-prelude/m);
      expect(outcome.toolResults.map((r) => r.tool)).toEqual(["reply"]);
      expect(events.find((e) => e.type === "reasoning")).toBeUndefined();
      expect(events.find((e) => e.type === "llm_raw_completion")).toMatchObject({
        reasoningTokens: 0,
      });
      expect(events.find((e) => e.type === "parse_retry")).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("thinking: off — the repair prompt strips and re-appends the disabled marker, never an open tag", async () => {
    const restore = withLocalModelsConfig({ thinking: "off" });
    try {
      const { seen, outcome } = await runQwen(["not json at all", CALL]);
      expect(seen).toHaveLength(2);
      const repair = seen[1]!.prompt;
      expect(repair).toContain("### tool-call-repair");
      expect(repair.endsWith("<think>\n\n</think>\n\n")).toBe(true);
      // One marker at the end; the original one was stripped before the notice.
      expect(repair.match(/<think>/g)).toHaveLength(1);
      expect(repair.indexOf("### tool-call-repair")).toBeLessThan(repair.indexOf("<think>"));
      expect(seen[1]!.grammar).toMatch(/^root ::= tool-call-array$/m);
      expect(outcome.toolResults.map((r) => r.tool)).toEqual(["reply"]);
    } finally {
      restore();
    }
  });

  it("thinking: on keeps the prefill, the prelude and the open-tag parse", async () => {
    const restore = withLocalModelsConfig({ thinking: "on" });
    try {
      const { seen, events, baseGrammar } = await runQwen([`why</think>\n${CALL}`]);
      expect(seen[0]!.prompt.endsWith("<think>\n")).toBe(true);
      expect(seen[0]!.grammar).toBe(baseGrammar);
      expect(events.find((e) => e.type === "reasoning")).toMatchObject({ text: "why" });
    } finally {
      restore();
    }
  });
});
