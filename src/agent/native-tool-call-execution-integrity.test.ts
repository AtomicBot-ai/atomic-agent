import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { OpenAiProvider } from "../llm/provider/openai/openai-provider.js";
import { openAiToolCallAdapter } from "../llm/provider/openai/openai-tool-call-adapter.js";
import type { CompletionRequest, CompletionResult } from "../llm/provider/completion-types.js";
import { executeStep, type StepDependencies } from "./step-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { SlotManager } from "../llm/slot-manager.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import { buildGrammar } from "../llm/grammar/build-grammar.js";
import { createEmptySessionState } from "../session/session-state.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import type { CapabilitiesSummary, SkillCatalogEntry } from "../prompt/stable-prefix.js";

/**
 * Execution-integrity regression suite for the native OpenAI-compatible
 * tool-call path.
 *
 * Drives the real `OpenAiProvider` (SSE parsing) and the real
 * `executeStep()` (tool dispatch) with an instrumented no-op tool that
 * only counts invocations — never a real filesystem/network/shell effect.
 *
 * Proves, at the actual dispatch boundary, that:
 *  - a malformed or ambiguously-terminated tool call is never invoked,
 *  - a healthy call still executes exactly once,
 *  - an explicit `finish_reason: "length"` still fails closed.
 */

const tools: NonNullable<CompletionRequest["tools"]> = [
  { type: "function", function: { name: "os__fs__delete", parameters: { type: "object", properties: {} } } },
];

const parallelTools: NonNullable<CompletionRequest["tools"]> = [
  { type: "function", function: { name: "os__fs__read", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "os__fs__grep", parameters: { type: "object", properties: {} } } },
];

function sseFrame(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function sseTail(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}`;
}

/** Streams one tool call's arguments, then the connection just ends — no
 * finish_reason chunk, no `[DONE]`. */
function eofBody(toolCallArgs: string, toolName = "os__fs__delete"): string {
  return (
    sseFrame({
      choices: [
        {
          index: 0,
          delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: toolName, arguments: "" } }] },
          finish_reason: null,
        },
      ],
    }) +
    sseFrame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: toolCallArgs } }] }, finish_reason: null }] })
  );
}

function parallelEofBody(): string {
  return (
    sseFrame({
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              { index: 0, id: "call_a", type: "function", function: { name: "os__fs__read", arguments: "" } },
              { index: 1, id: "call_b", type: "function", function: { name: "os__fs__grep", arguments: "" } },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    sseFrame({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '{"path":"a.txt"}' } },
              { index: 1, function: { arguments: '{"path":"b.txt' } },
            ],
          },
          finish_reason: null,
        },
      ],
    })
  );
}

function unindexedDistinctIdBody(): string {
  return (
    sseFrame({
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ id: "call_a", type: "function", function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' } }] }, finish_reason: null }],
    }) +
    sseFrame({
      choices: [{ index: 0, delta: { tool_calls: [{ id: "call_b", type: "function", function: { name: "os__fs__grep", arguments: '{"path":"b.txt"}' } }] }, finish_reason: null }],
    }) +
    sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
    "data: [DONE]\n\n"
  );
}

function qwenTaggedBody(finishReason: string | null = null): string {
  return sseFrame({
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: "<tool_call><function=os__fs__delete></function></tool_call>",
        },
        finish_reason: finishReason,
      },
    ],
  });
}

function healthyBody(toolCallArgs: string, toolName = "os__fs__delete"): string {
  return (
    eofBody(toolCallArgs, toolName) +
    sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) +
    "data: [DONE]\n\n"
  );
}

function lengthTerminatedBody(toolCallArgs: string, toolName = "os__fs__delete"): string {
  return (
    eofBody(toolCallArgs, toolName) +
    sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) +
    "data: [DONE]\n\n"
  );
}

function fetchReturning(body: string) {
  return (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
}

function fetchErroringMidStream(prefixBody: string) {
  return (async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(prefixBody));
        controller.error(new Error("simulated transport read error"));
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

async function drainCompleteStream(
  fetchImpl: typeof fetch,
  options?: {
    taggedToolCompatibility?: "qwen";
    requestTools?: NonNullable<CompletionRequest["tools"]>;
  },
): Promise<CompletionResult> {
  const provider = new OpenAiProvider({
    id: "test",
    baseUrl: "https://example.invalid",
    apiKey: "",
    defaultChatModel: "m",
    fetchImpl,
    ...(options?.taggedToolCompatibility
      ? { taggedToolCompatibility: options.taggedToolCompatibility }
      : {}),
  });
  const gen = provider.completeStream({
    prompt: "delete widget.txt",
    tools: options?.requestTools ?? tools,
  });
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
}

function makeCaps(): CapabilitiesSummary {
  return { platform: "linux", arch: "x64", browserChannel: "chrome", workingDir: "/work", hasClipboard: false, hasWmctrl: false, hasNotifications: false };
}

async function runStepThroughLlmComplete(
  llmComplete: StepDependencies["llmComplete"],
  registerTools: (registry: ToolRegistry) => void,
): Promise<{ outcomeOrError: unknown }> {
  const registry = new ToolRegistry();
  registerTools(registry);
  registry.register({
    name: "reply",
    description: "reply",
    readonly: true,
    async run(args: Record<string, unknown>) {
      return compressToolResult({ tool: "reply", status: "ok", output: String(args.text ?? "") });
    },
  });

  const grammarsDir = join(process.cwd(), "grammars");
  const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
  const session = createEmptySessionState({ id: "s-integrity", workingDir: "/w" });
  const deps: StepDependencies = {
    registry,
    slotManager: new SlotManager(2),
    llmComplete,
    grammar,
    profile: PLAIN_INSTRUCT_PROFILE,
    toolTransport: "native_tools",
    toolCallAdapter: openAiToolCallAdapter,
    supportsSlotAffinity: false,
  };

  let outcomeOrError: unknown;
  try {
    outcomeOrError = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: makeCaps(),
        skillCatalog: [] as SkillCatalogEntry[],
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "delete the widget",
      },
      deps,
    );
  } catch (err) {
    outcomeOrError = err;
  }
  return { outcomeOrError };
}

/** End-to-end: drives the real SSE parser via a fake fetch, then feeds
 * the resulting real CompletionResult into the real step executor. */
async function runStepFromFetch(
  fetchImpl: typeof fetch,
  registerTools: (registry: ToolRegistry) => void,
  options?: {
    taggedToolCompatibility?: "qwen";
    requestTools?: NonNullable<CompletionRequest["tools"]>;
  },
): Promise<{ outcomeOrError: unknown; completion: CompletionResult }> {
  const completion = await drainCompleteStream(fetchImpl, options);
  const { outcomeOrError } = await runStepThroughLlmComplete(async () => completion, registerTools);
  return { outcomeOrError, completion };
}

function countingTool(name: string) {
  let count = 0;
  return {
    executions: () => count,
    register: (registry: ToolRegistry) => {
      registry.register({
        name,
        description: "instrumented no-op test tool",
        readonly: false,
        async run(args: Record<string, unknown>) {
          count += 1;
          return compressToolResult({ tool: name, status: "ok", output: `noop args=${JSON.stringify(args)}` });
        },
      });
    },
  };
}

describe("native tool-call execution integrity", () => {
  it("keeps distinct unindexed tool calls separate when ids differ", async () => {
    const result = await drainCompleteStream(fetchReturning(unindexedDistinctIdBody()), {
      requestTools: parallelTools,
    });

    expect(result.toolCalls).toEqual([
      { id: "call_a", type: "function", function: { name: "os__fs__read", arguments: '{"path":"a.txt"}' } },
      { id: "call_b", type: "function", function: { name: "os__fs__grep", arguments: '{"path":"b.txt"}' } },
    ]);
  });
  it("1. healthy valid tool call: executions = 1", async () => {
    const tool = countingTool("os.fs.delete");
    const { outcomeOrError } = await runStepFromFetch(fetchReturning(healthyBody('{"path":"widget.txt"}')), tool.register);
    expect(tool.executions()).toBe(1);
    expect(outcomeOrError).not.toBeInstanceOf(Error);
  });

  it("2. malformed JSON + clean terminal (finish_reason: tool_calls): executions = 0", async () => {
    const tool = countingTool("os.fs.delete");
    const { outcomeOrError } = await runStepFromFetch(fetchReturning(healthyBody('{"path":"widget.txt')), tool.register);
    expect(tool.executions()).toBe(0);
    // Routed through the existing one-shot repair path, not a silent {} execute.
    expect(outcomeOrError).toBeInstanceOf(Error);
  });

  it("3. malformed JSON + abrupt EOF (no finish_reason, no [DONE]): executions = 0", async () => {
    const tool = countingTool("os.fs.delete");
    const { outcomeOrError, completion } = await runStepFromFetch(fetchReturning(eofBody('{"path":"widget.txt')), tool.register);
    expect(completion.finishReason).toBeNull();
    expect(completion.truncated).toBe(true); // now correctly flagged
    expect(tool.executions()).toBe(0);
    expect(outcomeOrError).toBeInstanceOf(Error);
  });

  it("4. container-level truncated JSON + abrupt EOF: executions = 0", async () => {
    const tool = countingTool("os.shell.run");
    const { outcomeOrError } = await runStepFromFetch(
      fetchReturning(eofBody('{"commands":["npm install","npm test"', "os__shell__run")),
      tool.register,
    );
    expect(tool.executions()).toBe(0);
    expect(outcomeOrError).toBeInstanceOf(Error);
  });

  it("5. syntactically COMPLETE JSON but ambiguous EOF: executions = 0", async () => {
    const tool = countingTool("os.fs.delete");
    const { outcomeOrError, completion } = await runStepFromFetch(fetchReturning(eofBody('{"path":"widget.txt"}')), tool.register);
    expect(completion.finishReason).toBeNull();
    expect(completion.truncated).toBe(true);
    expect(tool.executions()).toBe(0);
    expect(outcomeOrError).toBeInstanceOf(Error);
  });

  it("6. explicit finish_reason: length: executions = 0 (control, unchanged)", async () => {
    const tool = countingTool("os.fs.delete");
    const { outcomeOrError, completion } = await runStepFromFetch(fetchReturning(lengthTerminatedBody('{"path":"widget.txt"}')), tool.register);
    expect(completion.finishReason).toBe("length");
    expect(completion.truncated).toBe(true);
    expect(tool.executions()).toBe(0);
    expect(outcomeOrError).toBeInstanceOf(Error);
  });

  it("7. parallel calls: provider derives ambiguous EOF and neither call executes", async () => {
    const toolA = countingTool("os.fs.read");
    const toolB = countingTool("os.fs.grep");
    const { outcomeOrError, completion } = await runStepFromFetch(
      fetchReturning(parallelEofBody()),
      (registry) => {
        toolA.register(registry);
        toolB.register(registry);
      },
      { requestTools: parallelTools },
    );
    expect(completion.toolCalls).toHaveLength(2);
    expect(completion.finishReason).toBeNull();
    expect(completion.truncated).toBe(true);
    expect(completion.stop).toBe(false);
    expect(toolA.executions()).toBe(0);
    expect(toolB.executions()).toBe(0);
    expect(outcomeOrError).toBeInstanceOf(Error);
  });

  it("8. stream read error mid-stream: executions = 0", async () => {
    const tool = countingTool("os.fs.delete");
    let threw = false;
    try {
      await drainCompleteStream(fetchErroringMidStream(eofBody('{"path":"widget.txt')));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(tool.executions()).toBe(0);
  });

  it("9. compatibility: finish_reason sent but connection ends without [DONE] must still be trusted as a clean completion", async () => {
    // Some OpenAI-compatible providers omit the [DONE] sentinel entirely
    // but do send a real finish_reason on the last data chunk. That is a
    // trustworthy terminal signal on its own and must NOT be treated as
    // ambiguous just because [DONE] never arrived.
    const bodyWithFinishReasonButNoDone =
      eofBody('{"path":"widget.txt"}') +
      sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    // deliberately no "data: [DONE]\n\n" appended
    const tool = countingTool("os.fs.delete");
    const { outcomeOrError, completion } = await runStepFromFetch(fetchReturning(bodyWithFinishReasonButNoDone), tool.register);
    expect(completion.finishReason).toBe("tool_calls");
    expect(completion.truncated).toBe(false);
    expect(tool.executions()).toBe(1);
    expect(outcomeOrError).not.toBeInstanceOf(Error);
  });

  it("10. compatibility: plain text-only response with ambiguous EOF is unaffected by the tool-call fix", async () => {
    const textOnlyEofBody = sseFrame({ choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] });
    const completion = await drainCompleteStream(fetchReturning(textOnlyEofBody));
    expect(completion.toolCalls).toBeUndefined();
    expect(completion.truncated).toBe(false);
    expect(completion.stop).toBe(true);
  });

  it("11. qwen tagged tool call with ambiguous EOF is fail-closed after adaptation", async () => {
    const tool = countingTool("os.fs.delete");
    const { outcomeOrError, completion } = await runStepFromFetch(
      fetchReturning(qwenTaggedBody()),
      tool.register,
      { taggedToolCompatibility: "qwen" },
    );
    expect(completion.toolCalls).toHaveLength(1);
    expect(completion.finishReason).toBe("tool_calls");
    expect(completion.truncated).toBe(true);
    expect(completion.stop).toBe(false);
    expect(tool.executions()).toBe(0);
    expect(outcomeOrError).toBeInstanceOf(Error);
  });

  it("12. qwen tagged tool call with explicit terminal finish reason still executes", async () => {
    const tool = countingTool("os.fs.delete");
    const { outcomeOrError, completion } = await runStepFromFetch(
      fetchReturning(qwenTaggedBody("stop")),
      tool.register,
      { taggedToolCompatibility: "qwen" },
    );
    expect(completion.toolCalls).toHaveLength(1);
    expect(completion.finishReason).toBe("tool_calls");
    expect(completion.truncated).toBe(false);
    expect(completion.stop).toBe(true);
    expect(tool.executions()).toBe(1);
    expect(outcomeOrError).not.toBeInstanceOf(Error);
  });

  it("13. final finish_reason event without trailing blank line is flushed at EOF", async () => {
    const body =
      eofBody('{"path":"widget.txt"}') +
      sseTail({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    const tool = countingTool("os.fs.delete");
    const { outcomeOrError, completion } = await runStepFromFetch(fetchReturning(body), tool.register);
    expect(completion.finishReason).toBe("tool_calls");
    expect(completion.truncated).toBe(false);
    expect(completion.stop).toBe(true);
    expect(tool.executions()).toBe(1);
    expect(outcomeOrError).not.toBeInstanceOf(Error);
  });

  it("14. final [DONE] event without trailing blank line is flushed at EOF", async () => {
    const body = eofBody('{"path":"widget.txt"}') + "data: [DONE]";
    const tool = countingTool("os.fs.delete");
    const { outcomeOrError, completion } = await runStepFromFetch(fetchReturning(body), tool.register);
    expect(completion.finishReason).toBeNull();
    expect(completion.truncated).toBe(false);
    expect(completion.stop).toBe(true);
    expect(tool.executions()).toBe(1);
    expect(outcomeOrError).not.toBeInstanceOf(Error);
  });
});
