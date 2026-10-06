export type { ApprovalBarrierReport } from "./step/step-batch-policy.js";
export { approvalBarrierSegments, emptyApprovalBarrierReport, formatApprovalBarrierNotice } from "./step/step-batch-policy.js";
import { chatLinesOf, groundingTextsOf } from "../memory/name-grounding.js";
import { createStepBatchPolicy, executeCallsInOrder, emptyApprovalBarrierReport, executeWithApprovalBarriers, formatApprovalBarrierNotice } from "./step/step-batch-policy.js";
import { parseStepBatch, finishStepBatchRepair } from "./step/step-batch-parsing.js";
import { prepareStepDispatch } from "./step/step-evidence.js";
import { commitStepBatch } from "./step/step-commit.js";
export type { BatchTrimResult, BatchTrimPolicy } from "./step/step-batch-policy.js";
export { isApprovalGatedOnlyFailure, TRIM_REFUSED_BY_PLAN_MODE, TRIM_REFUSED_BY_FUSION_GATE, turnPolicyForTrim, trimBatchToFirstApprovalGated, formatBatchTrimNotice, formatWaveSplitNotice, callArgsSchemaValid } from "./step/step-batch-policy.js";
export { formatFabricatedTranscriptNotice } from "./step/step-evidence.js";
export { readReplyAttachments } from "./step/step-commit.js";
import type { StepDependencies, StepContext, StepOutcome } from "./step/step-contract.js";
export type { LlmStreamParams, LlmCompleteStream, StepDependencies, StepApprovalPostureSource, StepContext, StepTerminal, StepOutcome } from "./step/step-contract.js";
import { toLlmFailure } from "./step/step-errors.js";
export { BatchValidationError } from "./step/step-errors.js";
import { completionAssumesOpenReasoning, resolveReasoning } from "./step/step-reasoning.js";
import { runInitialCompletion } from "./step/step-inference.js";
import { isNativeToolsEmptyCompletionHandledByParser, isGrammarEmptyCompletionWorthRepairing, parseDepsFor, replyCapSent, prepareStepRepair, finishStepRepair } from "./step/step-parsing.js";
export { REPAIR_MAX_TOKENS } from "./step/step-parsing.js";
import { prepareStepInference } from "./step/step-inference.js";

import { executeBatch, toBatchInputs } from "./dispatch/batch-scheduler.js";

import { ModelError, detectModelFailure } from "../llm/index.js";
// The detector moved to the llm layer so the stream consumer can share its
// rules; re-exported for existing importers.
export {
  FABRICATED_TRANSCRIPT_MIN_LINES,
  detectFabricatedToolTranscript,
} from "../llm/index.js";
export type { FabricatedToolTranscript } from "../llm/index.js";

import type { CompletionResult } from "../llm/llama-server-client.js";

import { userNamedPaths } from "../tools/read-scope/index.js";

export type { ApprovalBarrierStopCause, PromptCapturedTokens, StepEvent } from "./step-events.js";

/**
 * Executes exactly one agent step: builds the prompt, calls the LLM under
 * the GBNF grammar, parses the resulting tool call, runs the tool,
 * appends `assistant_tool_call` + `tool_result` (or `assistant_reply`)
 * turns to the conversation, and returns the updated session state.
 *
 * Any terminal failure is normalised into an `LlmFailure` subclass before
 * the `step_error` event fires, so downstream consumers (traces, metrics,
 * TUI) can rely on the `category` field without running their own
 * classifier.
 */
export async function executeStep(
  ctx: StepContext,
  deps: StepDependencies,
): Promise<StepOutcome> {
  try {
    return await executeStepInner(ctx, deps);
  } catch (err) {
    const failure = toLlmFailure(err, ctx);
    deps.onEvent?.({
      type: "step_error",
      error: failure,
      category: failure.category,
    });
    throw failure;
  }
}

async function executeStepInner(
  ctx: StepContext,
  deps: StepDependencies,
): Promise<StepOutcome> {
  const prepared = prepareStepInference(ctx, deps);
  const { prompt, slot, replyCap, thinkingOff, llmParams } = prepared;

  const firstAttempt = await runInitialCompletion({
    ctx,
    deps,
    prompt,
    slot,
    llmParams,
    thinkingOff,
  });
  // The server named the slot it put a pending session's prompt in: pin
  // it so every later request of the session — the repair retry below
  // included — lands on the cache instead of asking again.
  if (
    slot.pending &&
    deps.supportsSlotAffinity &&
    firstAttempt.completion.slotId >= 0
  ) {
    deps.slotManager.pin(
      ctx.session.id,
      firstAttempt.completion.slotId,
      slot.prefixHash,
    );
    llmParams.slotId = firstAttempt.completion.slotId;
    deps.logger?.debug("slot pinned from completion", {
      sessionId: ctx.session.id,
      slotId: firstAttempt.completion.slotId,
    });
  }
  let completion = firstAttempt.completion;

  // Parse-side prefill assumption for a given completion: keyed off the
  // transport that actually served it (cross-transport fallover swaps
  // it), never off the primary's configuration.
  const assumesOpenReasoning = (c: CompletionResult): boolean =>
    completionAssumesOpenReasoning(
      deps.profile,
      parseDepsFor(c, deps).toolTransport,
      thinkingOff,
    );

  // Prefer the dedicated `reasoning_content` channel when the server
  // (QwQ, DeepSeek-R1 with `--reasoning-format deepseek`) supplies it —
  // the content body then no longer embeds `<think>...</think>` blocks.
  // Fall back to extracting `<think>` from `content` for classic builds
  // and models that stream CoT inline.
  let reasoning = resolveReasoning(
    completion,
    deps.profile,
    assumesOpenReasoning(completion),
  );
  if (reasoning.length > 0) {
    deps.onEvent?.({
      type: "reasoning",
      stepIndex: ctx.stepIndex,
      text: reasoning,
    });
  }

  // Detect model-side defects before the parser wastes a retry on a
  // fundamentally broken completion (truncated / empty / no_stop). Native
  // tool-call providers are the exception for reasoning-only empty bodies:
  // the model may have thought but failed to emit a required tool call, and
  // the existing repair path can recover with a stricter one-shot prompt.
  const initialModelFailure = detectModelFailure(completion, {
    requestedMaxTokens: replyCapSent(completion, replyCap),
    defaultReplyCap: replyCap,
    stage: "initial",
    contextWindow: deps.contextWindow ?? null,
  });
  if (initialModelFailure !== null) {
    const initialParseDeps = parseDepsFor(completion, deps);
    const repairable = isGrammarEmptyCompletionWorthRepairing(
      initialParseDeps,
      initialModelFailure.reason,
    );
    if (
      !repairable &&
      !isNativeToolsEmptyCompletionHandledByParser(
        initialParseDeps,
        initialModelFailure.reason,
        completion,
      )
    ) {
      deps.logger?.warn("model-side completion defect", {
        sessionId: ctx.session.id,
        stepIndex: ctx.stepIndex,
        reason: initialModelFailure.reason,
      });
      throw new ModelError(
        initialModelFailure.reason,
        initialModelFailure.message,
        // Effective transport, not `deps.toolTransport`: on a
        // cross-transport fallover the served link is the one whose
        // rules decided this completion is terminal.
        //
        // `stage: "initial"` is the other half of the split: the same
        // `reason` + `transport` pair is also raised after the one-shot
        // repair below, and only this field tells the two apart.
        {
          transport: initialParseDeps.toolTransport,
          stage: "initial",
          ...(initialModelFailure.truncation
            ? { truncation: initialModelFailure.truncation }
            : {}),
        },
      );
    }
    if (repairable) {
      // Fall through to the parser: an empty body fails to parse, which
      // routes into the one-shot repair below. The repair's own
      // `detectModelFailure` still throws `ModelError` if the second
      // completion is empty too, so "twice empty" remains terminal.
      deps.logger?.warn("empty completion, repairing once", {
        sessionId: ctx.session.id,
        stepIndex: ctx.stepIndex,
      });
    }
  }
  const policy = createStepBatchPolicy(ctx, deps, assumesOpenReasoning);
  const parsingArgs = { ctx, deps, prepared, completion, assumesOpenReasoning, policy };
  let parsed = parseStepBatch(parsingArgs);
  if (!parsed.ok) {
    const repairArgs = { ctx, deps, ...prepared, parsed, assumesOpenReasoning, onRetryReasoning: (retryReasoning: string) => { reasoning = retryReasoning; } };
    const repair = prepareStepRepair(repairArgs);
    completion = await deps.llmComplete(repair.buildRequest());
    const retryParseDeps = finishStepRepair(repairArgs, repair, completion);
    parsed = finishStepBatchRepair(parsingArgs, completion, retryParseDeps);
  }
  const batch = parsed.batch;
  const admission = prepareStepDispatch(ctx, deps, batch, completion, policy);
  const { calls, batchSize } = admission;
  const progressNote = policy.progressNote;

  const stepStartedAt = Date.now();
  const inputs = toBatchInputs(calls);
  // Names of skills already loaded this session: a `skill.view` for any of
  // these is short-circuited inside `executeBatch` with a terse pointer
  // instead of re-reading and re-dumping the body.
  const loadedSkillNames = new Set(ctx.session.loadedSkills.map((s) => s.name));
  // The paths the user named so far, for the read scope: re-read from the
  // transcript every step so a path named mid-turn (steering) counts on
  // the next call, and nothing the model wrote ever widens it.
  const readRoots = userNamedPaths(ctx.session.turns);
  // What may vouch for a name `memory.profile.set` is asked to store
  // (ATO-200): the user's own messages so far, re-read every step for the
  // same reason, and never anything the model wrote.
  const userGroundingTexts = groundingTextsOf(chatLinesOf(ctx.session.turns));
  const barrierReport = policy.runBehindBarriers
    ? emptyApprovalBarrierReport()
    : null;
  const runBatch: typeof executeBatch =
    barrierReport !== null
      ? (batchInputs, batchRegistry, batchCtx) =>
          executeWithApprovalBarriers(
            batchInputs,
            batchRegistry,
            batchCtx,
            barrierReport,
          )
      : policy.runInOrder
        ? executeCallsInOrder
        : executeBatch;
  const batchOutcome = await runBatch(inputs, deps.registry, {
    workingDir: ctx.session.workingDir,
    sessionId: ctx.session.id,
    stepIndex: ctx.stepIndex,
    signal: ctx.signal,
    ...(readRoots.length > 0 ? { readRoots } : {}),
    userGroundingTexts,
    // A pinned step (fusion worker) runs its model-calling tools on the
    // same provider as its completions — `vision.describe` reads this.
    ...(deps.providerId !== undefined ? { providerId: deps.providerId } : {}),
    ...(deps.tracker ? { tracker: deps.tracker } : {}),
    ...(ctx.terminalOnly ? { terminalOnly: true } : {}),
    ...(ctx.toolSet !== undefined ? { toolSet: ctx.toolSet } : {}),
    ...(deps.isPlanMode ? { isPlanMode: deps.isPlanMode } : {}),
    ...(deps.isFusionOrchestrator
      ? {
          isFusionOrchestrator: deps.isFusionOrchestrator,
          ...(deps.fusionState ? { fusionState: deps.fusionState } : {}),
          ...(deps.onDelegated ? { onDelegated: deps.onDelegated } : {}),
        }
      : {}),
    ...(ctx.toolRole !== undefined ? { toolRole: ctx.toolRole } : {}),
    ...(batch.maxWaveSize !== undefined
      ? { maxWaveSize: batch.maxWaveSize }
      : {}),
    ...(loadedSkillNames.size > 0 ? { loadedSkillNames } : {}),
    onCallFinished: ({ batchIndex, result, durationMs }) => {
      deps.onEvent?.({
        type: "tool_call_executed",
        result,
        batchIndex,
        batchSize,
        durationMs,
      });
      deps.metrics?.recordTool({
        sessionId: ctx.session.id,
        tool: result.tool,
        status: result.status,
        durationMs,
      });
      deps.logger?.info("tool executed", {
        sessionId: ctx.session.id,
        stepIndex: ctx.stepIndex,
        batchIndex,
        batchSize,
        tool: result.tool,
        status: result.status,
        durationMs,
      });
    },
  });
  const stepDurationMs = Date.now() - stepStartedAt;

  // Reported once the barriers ran — what ran, what did not and why —
  // and before a cancellation throws, so a cancelled batch is counted
  // too. The notice reaches the model only when calls were left unrun.
  if (barrierReport !== null) {
    deps.onEvent?.({
      type: "batch_approval_barriers",
      stepIndex: ctx.stepIndex,
      originalSize: calls.length,
      waves: barrierReport.waves,
      barriers: barrierReport.barriers,
      retained: barrierReport.retained,
      invalidated: barrierReport.invalidated.length,
      ...(barrierReport.stoppedBy !== null
        ? {
            stoppedBy: {
              tool: barrierReport.stoppedBy.call.tool,
              batchIndex: barrierReport.stoppedBy.batchIndex,
              cause: barrierReport.stoppedBy.cause,
            },
          }
        : {}),
      cancelled: barrierReport.cancelled,
    });
    deps.metrics?.recordBatchApprovalBarriers({
      sessionId: ctx.session.id,
      originalSize: calls.length,
      waves: barrierReport.waves,
      barriers: barrierReport.barriers,
      retained: barrierReport.retained,
      invalidated: barrierReport.invalidated.length,
    });
    deps.logger?.info("approval barriers ran", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      waves: barrierReport.waves,
      barriers: barrierReport.barriers,
      retained: barrierReport.retained,
      invalidated: barrierReport.invalidated.map((call) => call.tool),
      stoppedBy: barrierReport.stoppedBy?.call.tool ?? null,
      cause: barrierReport.stoppedBy?.cause ?? null,
      cancelled: barrierReport.cancelled,
    });
    const notice = formatApprovalBarrierNotice(barrierReport, calls.length);
    if (notice !== null) {
      policy.appendTrimNotice(notice);
    }
  }

  return commitStepBatch({ ctx, deps, prompt, completion, reasoning, admission, batchOutcome, stepDurationMs, progressNote, trimmedBatchNotice: policy.trimmedBatchNotice, waveSplitNotice: policy.waveSplitNotice });
}
