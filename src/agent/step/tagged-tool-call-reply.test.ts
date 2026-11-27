import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { executeStep, type StepEvent } from "../step-executor.js";
import { formatTaggedToolCallNotice } from "./step-evidence.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { SlotManager } from "../../llm/slot-manager.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { buildGrammar } from "../../llm/grammar/build-grammar.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";
import type { CapabilitiesSummary } from "../../prompt/stable-prefix.js";
import type {
  CompletionResult,
  ToolCallTransport,
} from "../../llm/provider/completion-types.js";

/**
 * GitHub #999 / ATO-2428: a tagged `<tool_call>` block the adapter could
 * not run (unknown name, broken JSON, unclosed tag) used to become the
 * turn's reply, so the raw XML reached the user. It is now held the way
 * an invented text transcript is: not delivered, and the model is told.
 */

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

const ISSUE_BLOCK = [
  "<tool_call>",
  "<function=os.web__search>",
  "<parameter=maxResults>",
  "10",
  "</parameter>",
  "<parameter=query>",
  "test",
  "</parameter>",
  "</function>",
  "</tool_call>",
].join("\n");

function completionOf(
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

function loggingRegistry(log: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of ["os.fs.read", "reply"]) {
    registry.register({
      name,
      description: name,
      readonly: true,
      async run(args) {
        log.push(`${name} ${String(args.text ?? args.path ?? "")}`);
        return compressToolResult({ tool: name, status: "ok", output: name });
      },
    });
  }
  return registry;
}

async function runStep(
  completion: CompletionResult,
  transport: ToolCallTransport,
): Promise<{
  outcome: Awaited<ReturnType<typeof executeStep>>;
  log: string[];
  events: StepEvent[];
}> {
  const log: string[] = [];
  const events: StepEvent[] = [];
  const grammar =
    transport === "grammar"
      ? await buildGrammar(PLAIN_INSTRUCT_PROFILE, join(process.cwd(), "grammars"))
      : "";
  const outcome = await executeStep(
    {
      session: createEmptySessionState({ id: "s-tagged", workingDir: "/w" }),
      toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
      capabilities: CAPS,
      skillCatalog: [],
      stepIndex: 0,
      signal: new AbortController().signal,
      userMessage: "search the web for test",
    },
    {
      registry: loggingRegistry(log),
      slotManager: new SlotManager(2),
      llmComplete: async () => completion,
      grammar,
      profile: PLAIN_INSTRUCT_PROFILE,
      toolTransport: transport,
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      onEvent: (event) => events.push(event),
    },
  );
  return { outcome, log, events };
}

function expectHeld(
  result: Awaited<ReturnType<typeof runStep>>,
  blocks = 1,
): void {
  const { outcome, log, events } = result;
  expect(outcome.terminal).toBeNull();
  expect(log).toEqual([]);
  expect(events.some((e) => e.type === "assistant_reply")).toBe(false);
  expect(outcome.toolCalls.map((c) => c.tool)).toEqual(["reply"]);
  expect(outcome.toolResults[0]!.status).toBe("error");
  expect(outcome.toolResults[0]!.summary).toContain("not delivered");
  expect(outcome.trimmedBatchNotice).toBe(formatTaggedToolCallNotice(blocks));
}

describe("tagged <tool_call> text no parser ran (GitHub #999)", () => {
  it("native tools: the issue's block is not delivered as the reply", async () => {
    expectHeld(await runStep(completionOf(ISSUE_BLOCK), "native_tools"));
  });

  it("native tools: an unclosed tag at the end of the stream is not delivered", async () => {
    const cut = "<tool_call>\n<function=os.web__search>\n<parameter=query>\ntest";
    expectHeld(await runStep(completionOf(cut), "native_tools"));
  });

  it("native tools: broken Hermes JSON after prose is not delivered", async () => {
    const text =
      'Searching now.\n<tool_call>\n{"name": "os__web__search", "arguments": {"query": \n</tool_call>';
    expectHeld(await runStep(completionOf(text), "native_tools"));
  });

  it("grammar skipped: the block is not read as a prose reply", async () => {
    expectHeld(
      await runStep(completionOf(ISSUE_BLOCK, { grammarSkipped: true }), "grammar"),
    );
  });

  it("delivers a reply that quotes the format in a closed fence", async () => {
    const text = `Qwen writes a call like this:\n\`\`\`xml\n${ISSUE_BLOCK}\n\`\`\``;
    const { outcome, log } = await runStep(completionOf(text), "native_tools");
    expect(outcome.terminal).toBe("turn");
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("reply Qwen writes a call like this:");
    expect(outcome.trimmedBatchNotice).toBeUndefined();
  });

  it("tells the model what to do, naming the tag", () => {
    expect(formatTaggedToolCallNotice(1)).toContain("a <tool_call> block");
    expect(formatTaggedToolCallNotice(2)).toContain("2 <tool_call> blocks");
    expect(formatTaggedToolCallNotice(1)).toContain(
      "the exact name it was offered under",
    );
  });
});
