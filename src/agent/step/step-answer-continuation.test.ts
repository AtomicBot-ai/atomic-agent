import { describe, expect, it } from "vitest";
import { executeStep, type LlmStreamParams, type StepEvent } from "../step-executor.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { SlotManager } from "../../llm/slot-manager.js";
import { PLAIN_INSTRUCT_PROFILE, QWEN_THINK_PROFILE } from "../../llm/model-profile.js";
import type { ModelProfile } from "../../llm/model-profile.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";
import { replyTool } from "../../tools/conversation/reply.js";
import type { CapabilitiesSummary } from "../../prompt/stable-prefix.js";
import type { CompletionResult, ToolCallTransport } from "../../llm/provider/completion-types.js";
import { CUT_AGAIN_NOTICE } from "./answer-continuation.js";
import { THINKING_REPLY_CAP } from "./thinking-reply-cap.js";

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

function done(content: string, over: Partial<CompletionResult> = {}): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 20, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
    ...over,
  };
}

/** A llama-server reply stopped at `n_predict`: the reply cap, not the window. */
function cutAtCap(content: string, over: Partial<CompletionResult> = {}): CompletionResult {
  return done(content, {
    stop: false,
    truncated: true,
    finishReason: "length",
    stopType: "limit",
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 20, predictedTokens: 16_384 },
    ...over,
  });
}

/** A grammar reply array without its closing `}]`. */
function replyArray(text: string): string {
  return `[{"tool":"reply","args":{"text":${JSON.stringify(text)}}`;
}

interface Run {
  script: Array<CompletionResult | Error | ((params: LlmStreamParams) => CompletionResult)>;
  transport?: ToolCallTransport;
  profile?: ModelProfile;
  signal?: AbortSignal;
  maxTokens?: number;
}

function harness(run: Run) {
  const registry = new ToolRegistry();
  registry.register(replyTool);
  const requests: LlmStreamParams[] = [];
  const events: StepEvent[] = [];
  const step = () =>
    executeStep(
      {
        session: createEmptySessionState({ id: "s-continue", workingDir: "/w" }),
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: [],
        stepIndex: 0,
        signal: run.signal ?? new AbortController().signal,
        userMessage: "explain it in full",
        ...(run.maxTokens !== undefined ? { maxTokens: run.maxTokens } : {}),
      },
      {
        registry,
        slotManager: new SlotManager(2),
        grammar: 'root ::= "fixture"',
        profile: run.profile ?? PLAIN_INSTRUCT_PROFILE,
        toolTransport: run.transport ?? "grammar",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
        onEvent: (event) => events.push(event),
        llmComplete: async (params) => {
          requests.push(params);
          const next = run.script[requests.length - 1];
          if (next === undefined) throw new Error("no more scripted completions");
          if (next instanceof Error) throw next;
          return typeof next === "function" ? next(params) : next;
        },
      },
    );
  const continued = () =>
    events.filter((event) => event.type === "answer_continued");
  return { step, requests, events, continued };
}

describe("a reply cut at its length limit is continued once (ATO-1031)", () => {
  it("asks once for the rest and joins the two into one reply", async () => {
    const partial = "The answer has two parts. Part one: apples are red";
    const h = harness({
      script: [
        cutAtCap(`[{"tool":"reply","args":{"text":"${partial}`),
        done(`${replyArray(" and part two: bananas are yellow.")}}]`),
      ],
    });
    const outcome = await h.step();
    expect(h.requests).toHaveLength(2);
    expect(outcome.terminal).toBe("turn");
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]!.args).toEqual({
      text: "The answer has two parts. Part one: apples are red and part two: bananas are yellow.",
    });
    // The continuation quotes the partial; the first request did not.
    expect(h.requests[1]!.prompt).toContain("### answer-continuation");
    expect(h.requests[1]!.prompt).toContain(partial);
    expect(h.requests[0]!.prompt).not.toContain("### answer-continuation");
    // Same cap as the step: nothing raised, nothing lowered.
    expect(h.requests[1]!.maxTokens).toBe(h.requests[0]!.maxTokens);
    expect(h.continued()).toEqual([
      {
        type: "answer_continued",
        stepIndex: 0,
        cause: "reply_cap",
        partialChars: partial.length,
        outcome: "completed",
      },
    ]);
  });

  it("stops after one continuation that was cut too, with what arrived and a notice", async () => {
    const h = harness({
      script: [
        cutAtCap(`[{"tool":"reply","args":{"text":"First half of a long answer`),
        cutAtCap(`[{"tool":"reply","args":{"text":", and the second half was going to`),
        done(`${replyArray("never asked for")}}]`),
      ],
    });
    const outcome = await h.step();
    expect(h.requests).toHaveLength(2);
    expect(outcome.toolCalls[0]!.tool).toBe("reply");
    expect(outcome.toolCalls[0]!.args.text).toBe(
      `First half of a long answer, and the second half was going to\n\n${CUT_AGAIN_NOTICE}`,
    );
    expect(h.continued().map((event) => event.type === "answer_continued" && event.outcome)).toEqual([
      "cut_again",
    ]);
  });

  it("falls back to the original truncation when the continuation fails", async () => {
    const h = harness({
      script: [
        cutAtCap(`[{"tool":"reply","args":{"text":"Part of an answer`),
        new Error("connection reset"),
      ],
    });
    await expect(h.step()).rejects.toMatchObject({
      name: "ModelError",
      reason: "truncated",
      stage: "initial",
      truncation: { cause: "reply_cap" },
    });
    expect(h.requests).toHaveLength(2);
    expect(h.continued().map((event) => event.type === "answer_continued" && event.outcome)).toEqual([
      "abandoned",
    ]);
  });

  it("falls back too when the continuation is not a reply", async () => {
    const h = harness({
      script: [
        cutAtCap(`[{"tool":"reply","args":{"text":"Part of an answer`),
        done(`[{"tool":"finish","args":{"summary":"gave up"}}]`),
      ],
    });
    await expect(h.step()).rejects.toMatchObject({ name: "ModelError", reason: "truncated" });
    expect(h.requests).toHaveLength(2);
  });

  it("rethrows a cancellation instead of reporting the cut", async () => {
    const controller = new AbortController();
    const h = harness({
      signal: controller.signal,
      script: [
        cutAtCap(`[{"tool":"reply","args":{"text":"Part of an answer`),
        () => {
          controller.abort();
          throw new Error("aborted");
        },
      ],
    });
    const error = await h.step().then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(error).not.toBeNull();
    expect(error!.name).not.toBe("ModelError");
    expect(h.continued()).toEqual([]);
  });

  it("does not continue a full context window, a cut tool call or a cut thought", async () => {
    const cases: CompletionResult[] = [
      // No stop type and no usage: llama-server's overflow, the window.
      cutAtCap(`[{"tool":"reply","args":{"text":"Part of an answer`, { stopType: undefined, finishReason: null }),
      cutAtCap(`[{"tool":"os.fs.write","args":{"path":"a.txt","content":"half a fi`),
      cutAtCap(`still deciding what to write`, {}),
    ];
    for (const cut of cases) {
      const h = harness({ script: [cut, done(`${replyArray("unused")}}]`)] });
      await expect(h.step()).rejects.toMatchObject({ name: "ModelError", reason: "truncated" });
      expect(h.requests).toHaveLength(1);
      expect(h.continued()).toEqual([]);
    }
  });

  it("continues a native-tools prose answer and takes the rest from a reply call", async () => {
    const native = (over: Partial<CompletionResult>) =>
      done("", { slotId: -1, modelId: "cloud-model", ...over });
    const h = harness({
      transport: "native_tools",
      script: [
        native({
          content: "Here is the long answer, part one",
          stop: false,
          truncated: true,
          finishReason: "length",
          usage: { promptTokens: 6_000, completionTokens: 16_384, totalTokens: 22_384 },
        }),
        native({
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "reply", arguments: JSON.stringify({ text: " and part two." }) },
            },
          ],
        }),
      ],
    });
    const outcome = await h.step();
    expect(h.requests).toHaveLength(2);
    expect(outcome.toolCalls[0]!.args).toEqual({
      text: "Here is the long answer, part one and part two.",
    });
    expect(h.requests[1]!.prompt).toContain("function-calling interface");
  });
});

describe("a local thinking model's reply cap (ATO-1031)", () => {
  it("rides as localReplyCap under the untouched default, and not when the step names its own cap", async () => {
    const lifted = harness({ profile: QWEN_THINK_PROFILE, script: [done(`</think>${replyArray("hi")}}]`)] });
    await lifted.step();
    expect(lifted.requests[0]!.localReplyCap).toBe(THINKING_REPLY_CAP);
    expect(lifted.requests[0]!.maxTokens).toBeUndefined();

    const own = harness({
      profile: QWEN_THINK_PROFILE,
      maxTokens: 4_096,
      script: [done(`</think>${replyArray("hi")}}]`)],
    });
    await own.step();
    expect(own.requests[0]!.localReplyCap).toBeUndefined();
    expect(own.requests[0]!.maxTokens).toBe(4_096);

    const plain = harness({ script: [done(`${replyArray("hi")}}]`)] });
    await plain.step();
    expect(plain.requests[0]!.localReplyCap).toBeUndefined();
  });

  it("judges a cut against the lifted cap", async () => {
    const h = harness({
      profile: QWEN_THINK_PROFILE,
      script: [
        cutAtCap("a very long thought that never closes", {
          timing: { promptMs: 1, predictedMs: 1, promptTokens: 20, predictedTokens: THINKING_REPLY_CAP },
        }),
      ],
    });
    await expect(h.step()).rejects.toMatchObject({
      name: "ModelError",
      truncation: { cause: "reply_cap", requestedMaxTokens: THINKING_REPLY_CAP },
    });
  });
});
