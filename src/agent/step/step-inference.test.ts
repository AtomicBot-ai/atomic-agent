import { describe, expect, it } from "vitest";
import type { CompletionResult, StreamChunk } from "../../llm/provider/completion-types.js";
import { PLAIN_INSTRUCT_PROFILE, QWEN_THINK_PROFILE } from "../../llm/model-profile.js";
import { SlotManager } from "../../llm/slot-manager.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { StepContext, StepDependencies, LlmStreamParams } from "./step-contract.js";
import type { StepEvent } from "../step-events.js";
import { consumeStream, prepareStepInference, runInitialCompletion } from "./step-inference.js";
import { prepareStepRepair, finishStepRepair, type StepRepairArgs, tryParseToolCalls } from "./step-parsing.js";
import { BatchValidationError, toLlmFailure } from "./step-errors.js";
import { ModelError } from "../../llm/index.js";

function completion(overrides: Partial<CompletionResult> = {}): CompletionResult {
  return {
    content: '[{"tool":"reply","args":{"text":"ok"}}]',
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 1, predictedTokens: 1 },
    cacheHitTokens: 0,
    slotId: -1,
    modelId: "fixture",
    ...overrides,
  };
}

function fixture(): { ctx: StepContext; deps: StepDependencies } {
  return {
    ctx: {
      session: createEmptySessionState({ id: "step-owner-fixture", workingDir: "/fixture" }),
      toolDescriptors: [],
      skillCatalog: [],
      capabilities: {
        platform: "darwin", arch: "arm64", browserChannel: "chrome",
        workingDir: "/fixture", hasClipboard: false, hasWmctrl: false,
        hasNotifications: false,
      },
      stepIndex: 1,
      signal: new AbortController().signal,
      maxTokens: 2048,
    },
    deps: {
      registry: new ToolRegistry(),
      slotManager: new SlotManager(1),
      profile: PLAIN_INSTRUCT_PROFILE,
      grammar: 'root ::= "fixture"',
      toolTransport: "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      llmComplete: async () => completion(),
    },
  };
}

async function repairStep(args: StepRepairArgs) {
  const repair = prepareStepRepair(args);
  const completion = await args.deps.llmComplete(repair.buildRequest());
  return { completion, retryParseDeps: finishStepRepair(args, repair, completion) };
}

describe("step inference owner seams", () => {
  it("latches the serving transport before parsing and drains past the done frame", async () => {
    const events: StepEvent[] = [];
    let afterDone = false;
    const final = completion({ content: "", servedTransport: "grammar" });
    async function* stream(): AsyncGenerator<StreamChunk, CompletionResult, void> {
      yield { delta: 'checking</think>[{"tool":"reply","args":{"text":"ok"}}]', reasoningDelta: "", done: true, servedTransport: "grammar" };
      afterDone = true;
      return final;
    }
    const result = await consumeStream(stream(), 2, QWEN_THINK_PROFILE, "native_tools", false, (event) => events.push(event));
    expect(afterDone).toBe(true);
    expect(result.reasoningContent).toBe("checking");
    expect(result.content).toContain("</think>");
    expect(events.filter((event) => event.type === "reasoning_delta")).toEqual([
      { type: "reasoning_delta", stepIndex: 2, text: "checking" },
    ]);
    expect(events).toContainEqual({ type: "assistant_delta", text: "ok" });
  });

  it("closes an abandoned iterator and keeps the original consumer failure", async () => {
    const original = new Error("consumer stopped");
    const order: string[] = [];
    async function* stream(): AsyncGenerator<StreamChunk, CompletionResult, void> {
      try {
        yield { delta: "", reasoningDelta: "thinking", done: false };
        return completion();
      } finally {
        await Promise.resolve();
        order.push("closed");
        throw new Error("cleanup failure");
      }
    }
    await expect(consumeStream(stream(), 0, PLAIN_INSTRUCT_PROFILE, "native_tools", false, () => {
      order.push("consumer");
      throw original;
    })).rejects.toBe(original);
    expect(order).toEqual(["consumer", "closed"]);
  });

  it("keeps unary completion identity and reads the streaming callback at both old call sites", async () => {
    const { ctx, deps } = fixture();
    const final = completion();
    let reads = 0;
    Object.defineProperty(deps, "llmCompleteStream", {
      get() {
        reads += 1;
        return async function* (): AsyncGenerator<StreamChunk, CompletionResult, void> {
          return final;
        };
      },
    });
    const prepared = prepareStepInference(ctx, deps);
    const result = await runInitialCompletion({ ctx, deps, ...prepared });
    expect(reads).toBe(2);
    expect(result.completion).toBe(final);
  });

  it("keeps repair unary, inherits request wiring and memoizes the repair grammar variant", async () => {
    const { ctx, deps } = fixture();
    deps.toolTransport = "native_tools";
    deps.profile = QWEN_THINK_PROFILE;
    const order: string[] = [];
    const final = completion({ reasoningContent: "repair reasoning", servedTransport: "grammar" });
    let grammarReads = 0;
    let sent: LlmStreamParams | undefined;
    deps.llmComplete = async (params) => {
      order.push("unary");
      sent = params;
      expect(params.grammarPrompt?.()).toBe(params.grammarPrompt?.());
      return final;
    };
    deps.llmCompleteStream = async function* () {
      throw new Error("repair must not stream");
    };
    deps.onCompletion = () => order.push("completion");
    deps.onEvent = (event) => order.push(event.type);
    const prepared = prepareStepInference(ctx, deps);
    const requestSignal = new AbortController().signal;
    const params: LlmStreamParams = {
      ...prepared.llmParams,
      signal: requestSignal,
      slotId: 7,
      providerId: "pinned-provider",
      messages: { system: "prefix", droppedSummary: null, turns: [], tail: "current tail" },
    };
    const repaired = await repairStep({
      ctx, deps, ...prepared, llmParams: params,
      grammarPrompt: () => { grammarReads += 1; return "grammar base<think>"; },
      parsed: { ok: false, error: new BatchValidationError("invalid batch", ["bad"]) },
      assumesOpenReasoning: () => true,
      onRetryReasoning: () => order.push("reasoning-assigned"),
    });
    expect(repaired.completion).toBe(final);
    expect(repaired.retryParseDeps.toolTransport).toBe("grammar");
    expect(grammarReads).toBe(1);
    expect(sent?.signal).toBe(requestSignal);
    expect(sent?.slotId).toBe(7);
    expect(sent?.providerId).toBe("pinned-provider");
    expect(sent?.maxTokens).toBe(2048);
    expect(sent?.messages?.tail).toContain("### tool-call-repair");
    expect(sent?.prompt).toContain("native function-calling interface");
    expect(order).toEqual(["prompt_built", "prompt_captured", "parse_retry", "unary", "completion", "llm_completed", "llm_raw_completion", "reasoning", "reasoning-assigned"]);
  });

  it("assigns repair reasoning before the model-defect check and preserves error identity", async () => {
    const { ctx, deps } = fixture();
    const prepared = prepareStepInference(ctx, deps);
    const final = completion({ content: "", reasoningContent: "still thinking", stop: false, truncated: true });
    deps.llmComplete = async () => final;
    let assigned = "";
    const operation = repairStep({
      ctx, deps, ...prepared,
      parsed: { ok: false, error: new Error("bad input") },
      assumesOpenReasoning: () => false,
      onRetryReasoning: (reasoning) => { assigned = reasoning; },
    });
    await expect(operation).rejects.toBeInstanceOf(ModelError);
    expect(assigned).toBe("still thinking");
    const error = new ModelError("empty", "empty body");
    expect(toLlmFailure(error, ctx)).toBe(error);
  });

  it("honours the response transport rather than the primary parser", () => {
    const final = completion({ servedTransport: "grammar" });
    const { deps } = fixture();
    deps.toolTransport = "native_tools";
    const parsed = tryParseToolCalls(final, deps.profile, { ...deps, toolTransport: final.servedTransport ?? deps.toolTransport }, [], false);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.batch.calls[0]?.tool).toBe("reply");
  });
});
