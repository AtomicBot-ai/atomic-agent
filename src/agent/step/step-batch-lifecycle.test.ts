import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { SlotManager } from "../../llm/slot-manager.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { getConfig } from "../../config/index.js";
import type { CompletionResult } from "../../llm/provider/completion-types.js";
import type { ToolCallBatch, ToolCallPayload } from "../../llm/grammar/tool-call-grammar.js";
import type { StepContext, StepDependencies } from "./step-contract.js";
import type { StepEvent } from "../step-events.js";
import { BatchValidationError } from "./step-errors.js";
import { createStepBatchPolicy, validateBatch } from "./step-batch-policy.js";
import { prepareStepInference } from "./step-inference.js";
import { prepareStepRepair, finishStepRepair } from "./step-parsing.js";
import { parseStepBatch, finishStepBatchRepair } from "./step-batch-parsing.js";
import { prepareStepDispatch } from "./step-evidence.js";
import { commitStepBatch } from "./step-commit.js";
import { executeBatch, toBatchInputs } from "../dispatch/batch-scheduler.js";
import { CancelledError } from "../../llm/index.js";
import { executeStep } from "../step-executor.js";

function result(calls: ToolCallPayload[]): CompletionResult {
  return {
    content: JSON.stringify(calls), reasoningContent: "", stop: true, truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 1, predictedTokens: 1 },
    cacheHitTokens: 0, slotId: -1, modelId: "fixture",
  };
}

function fixture(): { ctx: StepContext; deps: StepDependencies; events: StepEvent[] } {
  const events: StepEvent[] = [];
  return {
    events,
    ctx: {
      session: createEmptySessionState({ id: "batch-owner-fixture", workingDir: "/fixture" }),
      toolDescriptors: [], skillCatalog: [],
      capabilities: {
        platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/fixture",
        hasClipboard: false, hasWmctrl: false, hasNotifications: false,
      },
      stepIndex: 1, signal: new AbortController().signal, maxTokens: 2048,
    },
    deps: {
      registry: new ToolRegistry(), slotManager: new SlotManager(1),
      profile: PLAIN_INSTRUCT_PROFILE, grammar: 'root ::= "fixture"',
      toolTransport: "grammar", toolCallAdapter: null, supportsSlotAffinity: false,
      llmComplete: async () => result([{ tool: "reply", args: { text: "ok" } }]),
      onEvent: (event) => events.push(event),
    },
  };
}

function register(deps: StepDependencies, name: string): void {
  deps.registry.register({
    name, description: "fixture", readonly: name !== "os.fs.write",
    run: async () => compressToolResult({ tool: name, status: "ok", output: name }),
  });
}

describe("step batch lifecycle owner seams", () => {
  it.each(["valid", "repair"])("does not yield between %s reasoning and parsed-tool admission", async (path) => {
    const { ctx, deps } = fixture();
    register(deps, "reply");
    const order: string[] = [];
    let attempt = 0;
    deps.llmComplete = async () => {
      attempt += 1;
      const value = result([{ tool: "reply", args: { text: "answer" } }]);
      if (path === "repair" && attempt === 1) value.content = "malformed output";
      else value.reasoningContent = "reasoning";
      return value;
    };
    deps.onEvent = (event) => {
      if (event.type === "reasoning") {
        order.push("reasoning");
        queueMicrotask(() => order.push("queued"));
      } else if (event.type === "tool_call_parsed") order.push("parsed");
    };
    await executeStep(ctx, deps);
    expect(order).toEqual(["reasoning", "parsed", "queued"]);
  });

  it("reads live grants before the level and runs an unattended mutation batch in emitted order", () => {
    const { ctx, deps } = fixture();
    register(deps, "os.fs.write");
    const reads: string[] = [];
    let level: 1 | 5 = 1;
    deps.approvalPosture = {
      sessionGrants: (id) => { reads.push(`grants:${id}`); return { categories: [] }; },
      getLevel: () => { reads.push(`level:${level}`); return level; },
    };
    const policy = createStepBatchPolicy(ctx, deps, () => false);
    const batch: ToolCallBatch = {
      kind: "batch", calls: [
        { tool: "os.fs.write", args: { path: "first", content: "a" } },
        { tool: "os.fs.write", args: { path: "second", content: "b" } },
      ],
    };
    const validation = validateBatch(batch, deps.registry);
    expect(validation.ok).toBe(false);
    if (validation.ok) throw new Error("expected approval-gated validation");
    expect(validation.error).toBeInstanceOf(BatchValidationError);
    level = 5;
    expect(policy.tryTrimApprovalGated(batch, validation.error)?.batch).toBe(batch);
    expect(policy.runInOrder).toBe(true);
    expect(reads).toEqual(["grants:batch-owner-fixture", "level:5"]);
    expect(policy.trimmedBatchNotice).toBeUndefined();
  });

  it("replaces an initial progress note with the note from the repaired batch", async () => {
    const { ctx, deps } = fixture();
    register(deps, "os.fs.read");
    const initial = result([
      { tool: "unclassified.fixture", args: {} },
      { tool: "os.fs.read", args: { path: "/fixture/initial" } },
      { tool: "reply", args: { text: "old note" } },
    ]);
    deps.llmComplete = async () => result([
      { tool: "os.fs.read", args: { path: "/fixture/a" } },
      { tool: "reply", args: { text: "new note" } },
    ]);
    const prepared = prepareStepInference(ctx, deps);
    const policy = createStepBatchPolicy(ctx, deps, () => false);
    const parsingArgs = { ctx, deps, prepared, completion: initial, assumesOpenReasoning: () => false, policy };
    const first = parseStepBatch(parsingArgs);
    if (first.ok) throw new Error("fixture must require repair");
    const repairArgs = { ctx, deps, ...prepared, parsed: first, assumesOpenReasoning: () => false, onRetryReasoning: () => {} };
    const repair = prepareStepRepair(repairArgs);
    const completion = await deps.llmComplete(repair.buildRequest());
    const retryParseDeps = finishStepRepair(repairArgs, repair, completion);
    const parsed = finishStepBatchRepair(parsingArgs, completion, retryParseDeps);
    expect(parsed.batch.calls.map((call) => call.tool)).toEqual(["os.fs.read"]);
    expect(policy.progressNote?.args.text).toBe("new note");
  });

  it("holds an unsupported check claim once, preserves the refused call and merges the next-step notice", () => {
    const { ctx, deps, events } = fixture();
    register(deps, "reply");
    let noticed = false;
    deps.claimEvidence = { noticed: () => noticed, markNoticed: () => { noticed = true; } };
    const policy = createStepBatchPolicy(ctx, deps, () => false);
    policy.appendTrimNotice("existing notice");
    const call = { tool: "reply", args: { text: "Tests pass." } };
    const batch: ToolCallBatch = { kind: "single", calls: [call] };
    const admitted = prepareStepDispatch(ctx, deps, batch, result(batch.calls), policy);
    expect(noticed).toBe(true);
    expect(admitted.calls).toEqual([]);
    expect(admitted.suppressed?.call).toBe(call);
    expect(admitted.suppressed?.result.details?.notDelivered).toBe(true);
    expect(policy.trimmedBatchNotice?.startsWith("existing notice\n\n")).toBe(true);
    expect(events).toContainEqual({ type: "tool_call_parsed", call, batchIndex: 0, batchSize: 1 });
    const second = prepareStepDispatch(ctx, deps, batch, result(batch.calls), policy);
    expect(second.suppressed).toBeNull();
    expect(second.calls[0]).toBe(call);
  });

  it("commits results in model order after the second tool finishes first", async () => {
    const { ctx, deps } = fixture();
    let finishFirst = () => {};
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const settled: string[] = [];
    deps.registry.register({
      name: "os.fs.read", description: "fixture", readonly: true,
      async run(args) {
        const name = String(args.path);
        if (name === "first") await firstGate;
        else finishFirst();
        settled.push(name);
        return compressToolResult({ tool: "os.fs.read", status: "ok", output: name, details: { worldSnapshot: { digest: name, text: name } } });
      },
    });
    const calls = [
      { tool: "os.fs.read", args: { path: "first" } },
      { tool: "os.fs.read", args: { path: "second" } },
    ];
    const prepared = prepareStepInference(ctx, deps);
    const policy = createStepBatchPolicy(ctx, deps, () => false);
    const admission = prepareStepDispatch(ctx, deps, { kind: "batch", calls }, result(calls), policy);
    const batchOutcome = await executeBatch(toBatchInputs(admission.calls), deps.registry, {
      sessionId: ctx.session.id, workingDir: ctx.session.workingDir, stepIndex: ctx.stepIndex, signal: ctx.signal,
    });
    expect(settled).toEqual(["second", "first"]);
    const outcome = commitStepBatch({ ctx, deps, prompt: prepared.prompt, completion: result(calls), reasoning: "reasoning", admission, batchOutcome, stepDurationMs: 0, progressNote: null, trimmedBatchNotice: undefined, waveSplitNotice: undefined });
    expect(outcome.toolResults.map((entry) => entry.summary)).toEqual(["first", "second"]);
    expect(outcome.nextSession.worldSnapshot?.digest).toBe("second");
    expect(outcome.nextSession.latestResult?.summary).toBe("second");
    expect(outcome.nextSession.turns.filter((turn) => turn.kind === "assistant_tool_call").map((turn) => turn.args.path)).toEqual(["first", "second"]);
  });

  it("records the progress note before a cancelled batch raises its terminal failure", () => {
    const { ctx, deps, events } = fixture();
    const prepared = prepareStepInference(ctx, deps);
    const policy = createStepBatchPolicy(ctx, deps, () => false);
    const call = { tool: "os.fs.read", args: { path: "never ran" } };
    const note = { tool: "reply", args: { text: "progress" } };
    policy.setProgressNote(note);
    register(deps, call.tool);
    const admission = prepareStepDispatch(ctx, deps, { kind: "single", calls: [call] }, result([call]), policy);
    expect(() => commitStepBatch({
      ctx, deps, prompt: prepared.prompt, completion: result([call]), reasoning: "", admission,
      batchOutcome: { results: [{ batchIndex: 0, call, resourceClass: "pure_read", durationMs: 0, cancelled: true }], cancelled: true, loopSignals: [] },
      stepDurationMs: 0, progressNote: note, trimmedBatchNotice: undefined, waveSplitNotice: undefined,
    })).toThrow(CancelledError);
    expect(events.some((event) => event.type === "assistant_reply" && event.text === "progress")).toBe(true);
  });

  it("refuses wave splitting for invalid args even when the batch is entirely pure reads", () => {
    const { ctx, deps } = fixture();
    const config = getConfig();
    const cap = config.agent.maxParallelToolCalls;
    try {
      config.agent.maxParallelToolCalls = 1;
      const policy = createStepBatchPolicy(ctx, deps, () => false);
      const split = policy.trySplitPureReadWaves({ kind: "batch", calls: [
        { tool: "os.fs.read", args: { path: "/fixture/a" } },
        { tool: "os.fs.read", args: { path: 42 } },
      ] });
      expect(split).toBeNull();
      expect(policy.waveSplitNotice).toBeUndefined();
    } finally {
      config.agent.maxParallelToolCalls = cap;
    }
  });
});
