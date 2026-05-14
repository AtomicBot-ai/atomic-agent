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

  it("rejects a batch containing a terminal verb (forces solo via parser-retry)", async () => {
    // Same body returned twice — both attempts fail validation, so the
    // executor surfaces the validation error as a GrammarError after
    // the one-shot retry.
    const body = JSON.stringify([
      { tool: "os.fs.read", args: { path: "a" } },
      { tool: "reply", args: { text: "done" } },
    ]);
    await expect(runWithBody(body)).rejects.toThrow(
      /terminal verb 'reply' is forbidden inside a batch/,
    );
  });

  it("uses a structured repair prompt for validation retry", async () => {
    const registry = makeRegistry();
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const session = createEmptySessionState({ id: "s-repair", workingDir: "/w" });
    const prompts: string[] = [];
    const bodies = [
      JSON.stringify([
        { tool: "os.fs.read", args: { path: "a" } },
        { tool: "reply", args: { text: "done" } },
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
    expect(prompts[1]).toContain("terminal verb 'reply' is forbidden inside a batch");
    expect(prompts[1]).toContain("Use a length-1 array");
  });

  it(
    "for thinking profiles strips the trailing <think> prefill, " +
      "appends a closed think-block, and caps the repair completion at REPAIR_MAX_TOKENS",
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
      // emit the JSON body. For the repair attempt, the closed-think
      // block lives in the prompt itself, so the model would emit
      // just the JSON — but `normalizeContent` still prepends the
      // open tag, so we keep the same `</think>` shape for symmetry.
      const bodies = [
        `</think>${JSON.stringify([
          { tool: "os.fs.read", args: { path: "a" } },
          { tool: "reply", args: { text: "done" } },
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
      // and the model would loop on self-deliberation), and the prompt
      // must end with a closed empty think-block so generation skips
      // straight to JSON.
      const repairPrompt = prompts[1]!;
      expect(repairPrompt).toContain("### tool-call-repair");
      expect(repairPrompt.trimEnd().endsWith("<think>\n</think>")).toBe(true);
      // No second `<think>` open tag dangling before the closed block.
      const openTagOccurrences = repairPrompt.match(/<think>/g) ?? [];
      // Exactly one: the one inside the closed `<think></think>` pair.
      expect(openTagOccurrences.length).toBe(1);

      // Hard cap on the repair completion (defends against runaway
      // reasoning loops on the structured-repair path).
      expect(maxTokensSeen[0]).toBeUndefined();
      expect(maxTokensSeen[1]).toBe(REPAIR_MAX_TOKENS);
      expect(REPAIR_MAX_TOKENS).toBeLessThanOrEqual(1024);
    },
  );

  it("rejects a batch containing an approval-gated verb", async () => {
    const body = JSON.stringify([
      { tool: "os.fs.read", args: { path: "a" } },
      { tool: "os.shell.run", args: { cmd: "echo", args: ["hi"] } },
    ]);
    await expect(runWithBody(body)).rejects.toThrow(
      /approval-gated tool 'os.shell.run' is forbidden inside a batch/,
    );
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
