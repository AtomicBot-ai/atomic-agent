import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { executeStep } from "./step-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import {
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "../llm/model-profile.js";
import { REPAIR_MAX_TOKENS } from "./step-executor.js";
import { buildGrammar } from "../llm/grammar/build-grammar.js";
import { createEmptySessionState } from "../session/session-state.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import { replyTool } from "../tools/conversation/reply.js";
import { resetConfigCache } from "../config/index.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
} from "../prompt/stable-prefix.js";

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
    const session = createEmptySessionState({ id: "s-batch", workingDir: "/w" });
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

  it("native_tools: reasoning-only completion (empty content, no tool_calls) is salvaged as a reply", async () => {
    // Reasoning models served over OpenAI-compatible APIs (Qwen3.8 with
    // `preserve_thinking` on, DeepSeek-R1) routinely end hard turns with
    // the entire answer in `reasoning_content`, `content` empty and no
    // `tool_calls`. Failing fast here (the pre-Qwen3.8 contract) killed
    // whole sessions on healthy completions. The parser now salvages the
    // reasoning body — GBNF batch if one is embedded, otherwise a
    // length-1 `reply` — without burning a retry: no prompt is replayed,
    // so the original fail-fast concern (replaying the same prompt into
    // the same wall) does not apply.
    const registry = makeRegistry();
    const session = createEmptySessionState({
      id: "s-native-reasoning-only",
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
        userMessage: "привет",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        async llmComplete() {
          llmCalls += 1;
          return {
            content: "",
            reasoningContent: "I should call reply.",
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
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
      },
    );

    expect(llmCalls).toBe(1);
    expect(outcome.toolResults).toHaveLength(1);
    expect(outcome.toolResults[0]?.status).toBe("ok");
    expect(outcome.nextSession.turns.at(-1)).toMatchObject({
      kind: "assistant_reply",
      text: "I should call reply.",
    });
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
            content:
              '[{"tool":"reply","args":{"text":"Привет, инициат!"}}]',
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
    const session = createEmptySessionState({ id: "s-repair", workingDir: "/w" });
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
        { tool: "os.fs.write", args: { path: "src/constants.ts", content: "x" } },
        {
          tool: "os.fs.edit",
          args: { path: "src/a.ts", oldString: "x", newString: "y" },
        },
        {
          tool: "os.fs.edit",
          args: { path: "src/b.ts", oldString: "x", newString: "y" },
        },
      ]);
      const events: Array<{ type: string; reason?: string; kept?: string }> = [];
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

  it(
    "trims an approval-gated call even when it is not the first in the batch",
    async () => {
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
    },
  );

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
    expect(
      (tail[1] as { summary: string }).summary,
    ).toBe("read a");
    expect(
      (tail[3] as { summary: string }).summary,
    ).toBe("read b");
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
  function reads(n: number): Array<{ tool: string; args: Record<string, unknown> }> {
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
    const calls = [{ tool: "os.fs.write", args: { path: "a.ts", content: "x" } }];
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
      expect(events.filter((e) => e.type === "batch_wave_split")).toHaveLength(0);
      expect(events.filter((e) => e.type === "parse_retry")).toHaveLength(1);
      expect(llmCalls).toBe(2);
      expect(outcome.toolCalls).toHaveLength(1);
    },
  );
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
  }): Promise<{ captured: import("../llm/llama-server-client.js").CompletionResult | null }> {
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
    const session = createEmptySessionState({ id: "s-stream", workingDir: "/w" });
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
    let captured: import("../llm/llama-server-client.js").CompletionResult | null =
      null;
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
        session: createEmptySessionState({ id: "s-fallback", workingDir: "/w" }),
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
    let captured: { parallelToolCalls?: boolean } | null = null;
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
          captured = { parallelToolCalls: params.parallelToolCalls };
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
