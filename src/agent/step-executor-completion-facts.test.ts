import { describe, expect, it } from "vitest";
import { executeStep } from "./step-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import { ModelError } from "../llm/index.js";
import { createEmptySessionState } from "../session/session-state.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import type { CapabilitiesSummary } from "../prompt/stable-prefix.js";
import type { CompletionResult } from "../llm/provider/completion-types.js";

/**
 * ATO-2421: the `ModelError` a defective completion ends the step with
 * carries that completion's shape (finish reason, whether reasoning came
 * back, the server's counts), at both throw sites, so the error report
 * can tell which "empty" it was.
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

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({
    name: "reply",
    description: "reply",
    readonly: true,
    async run(args: Record<string, unknown>) {
      return compressToolResult({ tool: "reply", status: "ok", output: String(args.text ?? "") });
    },
  });
  return r;
}

function completion(overrides: Partial<CompletionResult>): CompletionResult {
  return {
    content: "",
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 0, predictedTokens: 0 },
    cacheHitTokens: 0,
    slotId: -1,
    modelId: "qwen3:8b",
    ...overrides,
  };
}

async function failStep(answers: CompletionResult[]): Promise<ModelError> {
  let call = 0;
  const err = await executeStep(
    {
      session: createEmptySessionState({ id: "s-facts", workingDir: "/w" }),
      toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
      capabilities: CAPS,
      skillCatalog: [],
      stepIndex: 0,
      signal: new AbortController().signal,
      userMessage: "hi",
    },
    {
      registry: registry(),
      slotManager: new SlotManager(2),
      async llmComplete() {
        const answer = answers[Math.min(call, answers.length - 1)]!;
        call += 1;
        return answer;
      },
      grammar: "",
      profile: PLAIN_INSTRUCT_PROFILE,
      toolTransport: "native_tools",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
    },
  ).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ModelError);
  return err as ModelError;
}

describe("ModelError completion facts (ATO-2421)", () => {
  it("the first-attempt throw carries the empty completion's shape", async () => {
    const err = await failStep([
      completion({
        finishReason: "stop",
        usage: { promptTokens: 4096, completionTokens: 1, totalTokens: 4097 },
      }),
    ]);
    expect(err.stage).toBe("initial");
    expect(err.completion).toEqual({
      finishReason: "stop",
      reasoningPresent: false,
      promptTokens: 4096,
      completionTokens: 1,
    });
  });

  it("the repair throw carries the repair completion's shape, not the first one's", async () => {
    const err = await failStep([
      // Reasoning only: the parser and the repair get a go at it.
      completion({
        reasoningContent: "I should greet the user.",
        finishReason: "stop",
        usage: { promptTokens: 9000, completionTokens: 40, totalTokens: 9040 },
      }),
      // Then nothing in any channel.
      completion({
        finishReason: "stop",
        usage: { promptTokens: 9100, completionTokens: 0, totalTokens: 9100 },
      }),
    ]);
    expect(err.stage).toBe("repair");
    expect(err.completion).toEqual({
      finishReason: "stop",
      reasoningPresent: false,
      promptTokens: 9100,
      completionTokens: 0,
    });
  });
});
