import type { ApprovalBarrierStopCause } from "../step-events.js";
import type { BatchCallInput } from "../dispatch/batch-contract.js";
import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import type { StepContext, StepDependencies } from "./step-contract.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { FabricatedToolTranscript } from "../../llm/index.js";
import { detectFabricatedToolTranscript } from "../../llm/index.js";
import { completionFreeText } from "./step-reasoning.js";
import type { ToolCallPayload, ToolCallBatch } from "../../llm/grammar/tool-call-grammar.js";
import { closingReplyBatch, splitProgressNoteReply } from "../progress-note-reply.js";
import type { BatchApprovalPosture } from "../tool-resource-class.js";
import { resourceClassFor, gatedCallRunsUnattended, isBatchable, isSoloRegardlessOfApproval } from "../tool-resource-class.js";
import { BatchValidationError } from "./step-errors.js";
import { getConfig } from "../../config/index.js";
import type { ToolRegistry } from "../../tools/tool-registry.js";
import { wouldRefuse as planModeWouldRefuse } from "../policies/plan-mode.js";
import { wouldRefuse as fusionGateWouldRefuse } from "../policies/fusion-orchestrator-mode.js";
import { executeBatch } from "../dispatch/batch-scheduler.js";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import { getDefaultArgsJsonSchema } from "../../prompt/default-tool-args-schemas.js";
import { validateJsonSchemaValue } from "../../llm/provider/openai/coerce-json-schema-value.js";
export function createStepBatchPolicy(
  ctx: StepContext,
  deps: StepDependencies,
  assumesOpenReasoning: (completion: CompletionResult) => boolean,
) {

  // Notice text injected into the NEXT step's `transientNotice` when
  // `executeStepInner` auto-trims a multi-call batch. Set only when the
  // trim fires; left undefined otherwise so the agent loop knows not to
  // overwrite a higher-priority pending notice (loop-detector hint).
  let trimmedBatchNotice: string | undefined;

  // Same lifecycle for the wave-split path: when an oversized pure-read
  // batch was mechanically split (issue #111), tell the model on the
  // next step so it understands its array ran in bounded waves rather
  // than all-at-once.
  let waveSplitNotice: string | undefined;

  // Set when a batch holding approval-gated calls is run whole, one call
  // after another in emitted order, because nobody would be asked to
  // approve any of them. See `batchRunsUnattended`.
  let runInOrder = false;

  // Set when a batch holding approval-gated calls that would prompt runs
  // behind approval barriers instead of being trimmed. See
  // `batchRunsBehindBarriers`.
  let runBehindBarriers = false;

  /**
   * Did this completion write tool calls and results out as text? Read
   * before the batch is touched and again once it is final — the same
   * scan, so the two cannot disagree.
   */
  const fabricationOf = (
    result: CompletionResult,
  ): FabricatedToolTranscript | null =>
    detectFabricatedToolTranscript(
      completionFreeText(result, deps.profile, assumesOpenReasoning(result)),
    ) ?? fabricationFromEarlyStop(result);

  // A `reply` batched with work tools is a progress note, not the end of
  // the turn (`progress-note-reply.ts`). Taken out before validation so
  // it is found in any position — `[reply, shell]` used to fail the
  // tail-only rule and go to repair — and so `[shell, reply]` leaves a
  // sole approval-gated call behind, which runs as one always did. The
  // note comes from the batch that executes: a repair re-emission
  // replaces whatever the first one carried. A completion that wrote an
  // invented transcript keeps today's refusal instead — its reply
  // reports work that never happened and is not kept as anything.
  let progressNote: ToolCallPayload | null = null;
  const takeProgressNote = (
    batch: ToolCallBatch,
    result: CompletionResult,
  ): { batch: ToolCallBatch; note: ToolCallPayload | null } => {
    if (fabricationOf(result) !== null) return { batch, note: null };
    // A reply batched only with memory writes is the answer: reordered
    // reply-last, the writes run and the reply ends the turn.
    const closing = closingReplyBatch(batch.calls, {
      terminalOnly: ctx.terminalOnly === true,
    });
    if (closing !== null) {
      return { batch: { ...batch, calls: closing }, note: null };
    }
    const split = splitProgressNoteReply(batch.calls, {
      terminalOnly: ctx.terminalOnly === true,
    });
    if (split === null) return { batch, note: null };
    deps.logger?.info("reply batched with work kept as a progress note", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      tools: split.calls.map((call) => call.tool),
    });
    return { batch: { ...batch, calls: split.calls }, note: split.note };
  };

  /**
   * Does every approval-gated call in `batch` run without a prompt at the
   * session's live approval posture? Only then may the batch run whole.
   *
   * The trim exists because a prompt per call cannot be answered for a
   * batch: approving the first write says nothing about the four behind
   * it, and a denial would leave later calls running against a state the
   * operator refused. With no prompt in the picture that reason is gone,
   * and trimming only throws generated work away — at level 5 on a local
   * model that was a 5-file emission (20 minutes of decode) cut to its
   * first file, then a 6-file retry cut to the one file already fine.
   *
   * Capped at `MAX_WAVE_SPLIT_CALLS` for the reason the wave split is: a
   * derailed emission must not become dozens of mutations.
   */
  const batchRunsUnattended = (batch: ToolCallBatch): boolean => {
    const source = deps.approvalPosture;
    if (!source) return false;
    if (batch.calls.length > MAX_WAVE_SPLIT_CALLS) return false;
    let posture: BatchApprovalPosture;
    try {
      const granted = source.sessionGrants?.(ctx.session.id).categories;
      posture = {
        level: source.getLevel(),
        ...(granted !== undefined ? { grantedCategories: granted } : {}),
      };
    } catch {
      return false;
    }
    return batch.calls.every(
      (call) =>
        resourceClassFor(call.tool) !== "approval_gated" ||
        gatedCallRunsUnattended(call.tool, posture),
    );
  };

  /**
   * May `batch` run behind approval barriers (issue #109) instead of
   * being trimmed to its first gated call? Then each gated call runs
   * alone, after the calls ahead of it settled, and the calls behind it
   * run only once it was approved and came back `ok` — with the payload
   * the model emitted, not a re-generated one.
   *
   * Every call is checked before anything runs, so a batch never starts
   * and then turns out to hold a call the runtime would not run. Not
   * eligible, and trimmed as before:
   *  - no approval posture wired (the documented "absent ⇒ trim");
   *  - the forced final step, plan mode or a fusion orchestrator turn —
   *    the trim's turn policy picks the survivor there, and a barrier
   *    refused by a gate would only throw the calls behind it away;
   *  - a `reply` / `finish` in the batch: a terminal is never replayed
   *    behind a barrier (a `reply` batched with work was already taken
   *    out as a progress note);
   *  - a tool the registry does not hold, one with no resource class,
   *    one that is solo for a reason other than approval
   *    (`fusion.delegate`), or arguments its schema rejects.
   * The caller has already sent an oversized batch to repair.
   */
  const batchRunsBehindBarriers = (batch: ToolCallBatch): boolean => {
    if (!deps.approvalPosture) return false;
    if (ctx.terminalOnly) return false;
    const policy = turnPolicyForTrim(deps);
    if (policy.refusedBy !== undefined || policy.preferTool !== undefined) {
      return false;
    }
    return batch.calls.every((call) => {
      const cls = resourceClassFor(call.tool);
      if (cls === "approval_gated") {
        if (isSoloRegardlessOfApproval(call.tool)) return false;
      } else if (!isBatchable(cls)) {
        return false;
      }
      if (!deps.registry.has(call.tool)) return false;
      return callArgsSchemaValid(call, ctx.toolDescriptors);
    });
  };

  /**
   * Inline helper: if a `BatchValidationError` is purely about
   * approval-gated tools batched together, either run the batch whole in
   * emitted order (nobody would be prompted — `batchRunsUnattended`),
   * run it behind approval barriers (`batchRunsBehindBarriers`), or
   * trim it to the first approval-gated call (length-1), emit the
   * observability event, and capture the notice for the next step.
   * Returns the batch to execute paired with a fresh `ok: true` parse
   * result, or `null` if the failure is not eligible (terminal verbs,
   * oversized, unknown resource class — those still go through the LLM
   * repair path).
   */
  const tryTrimApprovalGated = (
    batch: ToolCallBatch,
    error: BatchValidationError,
  ): { ok: true; batch: ToolCallBatch } | null => {
    if (!isApprovalGatedOnlyFailure(error)) return null;
    // On the final step the tail terminal is the one call that can run:
    // every non-terminal call is refused at dispatch, so keeping the
    // first approval-gated call would lose the reply for a refusal.
    if (ctx.terminalOnly) {
      const tail = batch.calls[batch.calls.length - 1];
      if (
        tail !== undefined &&
        batch.calls.length > 1 &&
        resourceClassFor(tail.tool) === "terminal"
      ) {
        const dropped = batch.calls.slice(0, -1);
        deps.onEvent?.({
          type: "batch_trimmed",
          stepIndex: ctx.stepIndex,
          originalSize: batch.calls.length,
          kept: tail.tool,
          dropped: dropped.map((call) => call.tool),
          reason: "approval-gated-batched",
        });
        deps.logger?.info("final step: batch trimmed to its tail terminal", {
          sessionId: ctx.session.id,
          stepIndex: ctx.stepIndex,
          kept: tail.tool,
          dropped: dropped.map((call) => call.tool),
        });
        return { ok: true, batch: { ...batch, calls: [tail] } };
      }
    }
    if (batchRunsUnattended(batch)) {
      runInOrder = true;
      deps.logger?.info(
        "approval-gated batch runs whole, in emitted order (no call would prompt)",
        {
          sessionId: ctx.session.id,
          stepIndex: ctx.stepIndex,
          size: batch.calls.length,
          tools: batch.calls.map((call) => call.tool),
        },
      );
      return { ok: true, batch };
    }
    // An oversized batch is never trim-eligible, even when its only
    // per-call reason is approval-gated (e.g. `[os.fs.write, 13 reads]`
    // with a cap of 8). Trimming would keep the write solo and silently
    // drop the 13 reads the model asked for; the oversized case must go
    // through the LLM repair path (or the wave split below) instead.
    if (batch.calls.length > getConfig().agent.maxParallelToolCalls) {
      return null;
    }
    // Someone would be asked: run the batch behind approval barriers when
    // every call checks out, so nothing the model emitted has to be
    // emitted again — the next step reads the results, not a retry list.
    if (batchRunsBehindBarriers(batch)) {
      runBehindBarriers = true;
      deps.logger?.info("approval-gated batch runs behind approval barriers", {
        sessionId: ctx.session.id,
        stepIndex: ctx.stepIndex,
        size: batch.calls.length,
        tools: batch.calls.map((call) => call.tool),
      });
      return { ok: true, batch };
    }
    const trim = trimBatchToFirstApprovalGated(batch, turnPolicyForTrim(deps));
    if (trim === null) return null;
    trimmedBatchNotice = formatBatchTrimNotice(trim);
    deps.onEvent?.({
      type: "batch_trimmed",
      stepIndex: ctx.stepIndex,
      originalSize: trim.originalSize,
      kept: trim.kept.tool,
      dropped: trim.dropped.map((call) => call.tool),
      ...(trim.refused.length > 0
        ? { refused: trim.refused.map(({ call }) => call.tool) }
        : {}),
      reason: "approval-gated-batched",
    });
    deps.metrics?.recordBatchTrimmed({
      sessionId: ctx.session.id,
      reason: "approval-gated-batched",
      originalSize: trim.originalSize,
      droppedCount: trim.dropped.length + trim.refused.length,
    });
    deps.logger?.info(
      "batch trimmed to the first approval-gated call that can run",
      {
        sessionId: ctx.session.id,
        stepIndex: ctx.stepIndex,
        originalSize: trim.originalSize,
        kept: trim.kept.tool,
        dropped: trim.dropped.map((call) => call.tool),
        refused: trim.refused.map(
          ({ call, reason }) => `${call.tool}: ${reason}`,
        ),
      },
    );
    return {
      ok: true,
      batch: { ...batch, calls: [trim.kept] },
    };
  };

  /**
   * Inline helper: mechanically split an oversized pure-read batch into
   * bounded waves (issue #111). Eligibility is strict — the batch must
   * be larger than `agent.maxParallelToolCalls` AND every call must
   * preflight as registered, argument-schema-valid, and classified
   * `pure_read`. A single non-`pure_read` call (approval-gated,
   * terminal, unknown class) or a schema-invalid arg kicks the batch
   * back to the LLM repair path, because wave-splitting would execute
   * calls the runtime is not allowed to batch (consent / ordering /
   * semantic intent the model is better placed to reconcile).
   */
  const trySplitPureReadWaves = (
    batch: ToolCallBatch,
  ): { ok: true; batch: ToolCallBatch } | null => {
    const cap = getConfig().agent.maxParallelToolCalls;
    const calls = batch.calls;
    if (calls.length <= cap) return null;
    // A ceiling, because "run it in waves" is not a licence to execute
    // an arbitrary array. A model that derails and emits 120 searches
    // would otherwise have every one run — 120 live requests and 240
    // transcript turns out of a single hallucinated emission — and the
    // loop detector cannot intervene: its gate runs once, before the
    // first call of the batch. Past the ceiling the batch goes back to
    // the model, which is what an oversized batch did before waves
    // existed.
    //
    // The ceiling counts CALLS, not waves: with a cap of 1 a fan-out of
    // fourteen reads is fourteen waves and perfectly reasonable, while
    // with a cap of 8 the same wave count would be 112 live requests.
    // What matters is how much work one emission can start.
    if (calls.length > MAX_WAVE_SPLIT_CALLS) return null;
    for (const call of calls) {
      if (resourceClassFor(call.tool) !== "pure_read") return null;
      if (!callArgsSchemaValid(call, ctx.toolDescriptors)) return null;
    }
    const waveCount = Math.ceil(calls.length / cap);
    const boundaries = Array.from({ length: waveCount }, (_, i) => i * cap);
    waveSplitNotice = formatWaveSplitNotice(calls.length, cap, waveCount);
    deps.onEvent?.({
      type: "batch_wave_split",
      stepIndex: ctx.stepIndex,
      originalSize: calls.length,
      cap,
      waveCount,
      boundaries,
    });
    deps.metrics?.recordBatchWaveSplit({
      sessionId: ctx.session.id,
      originalSize: calls.length,
      cap,
      waveCount,
    });
    deps.logger?.info("oversized pure-read batch split into bounded waves", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      originalSize: calls.length,
      cap,
      waveCount,
    });
    return {
      ok: true,
      batch: { ...batch, maxWaveSize: cap },
    };
  };
  return {
    fabricationOf, takeProgressNote, tryTrimApprovalGated, trySplitPureReadWaves,
    get runInOrder() { return runInOrder; },
    get runBehindBarriers() { return runBehindBarriers; },
    get progressNote() { return progressNote; },
    get trimmedBatchNotice() { return trimmedBatchNotice; },
    get waveSplitNotice() { return waveSplitNotice; },
    setProgressNote(note: ToolCallPayload | null) { progressNote = note; },
    appendTrimNotice(notice: string) {
      trimmedBatchNotice = trimmedBatchNotice === undefined ? notice : `${trimmedBatchNotice}\n\n${notice}`;
    },
  };
}

export type StepBatchPolicy = ReturnType<typeof createStepBatchPolicy>;



/**
 * Most tool calls one emission may run after a wave split. Generous
 * enough for any honest fan-out (a repo-wide read, a batch of searches)
 * and small enough that a hallucinated array goes back to the model
 * instead of hitting the network 120 times.
 */
export const MAX_WAVE_SPLIT_CALLS = 32;


export interface BatchValidation {
  ok: true;
}


export interface BatchValidationFailure {
  ok: false;
  error: BatchValidationError;
}


/**
 * Enforce batch invariants:
 *  - Every tool name resolves in the registry (defence in depth — the
 *    grammar already restricts this).
 *  - Terminal `reply` calls carry a non-empty `text` string before they
 *    can close the turn. This catches native-tools calls with `{}` args
 *    and routes them through the repair prompt instead of surfacing the
 *    reply tool's validation error as the assistant's final answer.
 *  - Every call has a known `ResourceClass`.
 *  - When `calls.length > 1`:
 *      * No `terminal` verbs (`reply` / `finish`) inside a batch.
 *      * No `approval_gated` verbs inside a batch.
 *      * `length <= agent.maxParallelToolCalls`.
 *  - Single-call payloads always pass — they preserve the legacy
 *    solo path semantics for any tool, including approval-gated and
 *    terminal verbs.
 *  - Terminal verbs (`reply` / `finish`) are allowed **only as the last
 *    element** of a multi-call batch — the executor enforces a barrier
 *    so the terminal call runs strictly after all non-terminal calls
 *    have completed. Terminals anywhere else (mid-batch, duplicated)
 *    are rejected with a structured per-call reason.
 */
export function validateBatch(
  batch: ToolCallBatch,
  registry: ToolRegistry,
): BatchValidation | BatchValidationFailure {
  const calls = batch.calls;
  const perCall: Array<string | null> = new Array(calls.length).fill(null);
  let firstError: string | null = null;

  // Note: missing-from-registry is intentionally NOT validated here.
  // That class of failure is surfaced as `ToolExecutionError` by the
  // step executor (matching the legacy single-call semantics) so the
  // agent loop's failure category is `tool`, not `grammar`. Replaying
  // the same prompt would not change the registry contents.
  void registry;
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]!;
    const terminalArgsError = validateTerminalArgs(call);
    if (terminalArgsError !== null) {
      perCall[i] = terminalArgsError;
      firstError ??= terminalArgsError;
    }
  }
  if (calls.length > 1) {
    const cap = getConfig().agent.maxParallelToolCalls;
    if (calls.length > cap) {
      const msg = `batch exceeds maxParallelToolCalls (${calls.length} > ${cap})`;
      firstError ??= msg;
    }
    const lastIdx = calls.length - 1;
    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i]!;
      const cls = resourceClassFor(call.tool);
      if (cls === "terminal") {
        // Terminal verbs are allowed only as the LAST call of the
        // batch. Any earlier position (or duplicated terminal) is
        // rejected — the runtime cannot keep firing tools after the
        // turn has been closed.
        if (i !== lastIdx) {
          const msg = `terminal verb '${call.tool}' must be the last call in a batch; got it at index ${i} of ${calls.length}`;
          perCall[i] = msg;
          firstError ??= msg;
        }
      } else if (cls === "approval_gated") {
        const msg = `approval-gated tool '${call.tool}' is forbidden inside a batch; emit it as a single call`;
        perCall[i] = msg;
        firstError ??= msg;
      } else if (!isBatchable(cls)) {
        // Unknown class: reject from any batch.
        const msg = `tool '${call.tool}' has no resource class and cannot be batched`;
        perCall[i] = msg;
        firstError ??= msg;
      }
    }
  }
  if (firstError !== null) {
    return {
      ok: false,
      error: new BatchValidationError(firstError, perCall),
    };
  }
  return { ok: true };
}


export function validateTerminalArgs(call: ToolCallPayload): string | null {
  if (call.tool !== "reply") return null;
  const text = call.args.text;
  if (typeof text === "string" && text.trim().length > 0) return null;
  return "reply tool requires args.text to be a non-empty string";
}


/**
 * Classify a `BatchValidationError`: is it "approval-gated calls in a
 * batch and nothing else" (mechanically fixable by trimming) or does
 * the batch also contain a terminal verb / unknown class / oversized
 * payload (which we keep routing through the LLM repair path because
 * trimming the wrong call could lose semantic intent the model is
 * better placed to reconcile)?
 *
 * The classifier is intentionally strict: every non-null per-call entry
 * must mention `approval-gated`. A single `terminal verb` or
 * `no resource class` reason kicks the batch back to repair.
 */
export function isApprovalGatedOnlyFailure(
  error: BatchValidationError,
): boolean {
  const reasons = error.perCall.filter(
    (entry): entry is string => entry !== null,
  );
  if (reasons.length === 0) return false;
  return reasons.every((reason) => reason.includes("approval-gated"));
}


/**
 * Trim a model-emitted batch down to a length-1 array containing the
 * **first** approval-gated call. The dropped calls are surfaced in
 * `dropped` so the caller can render a `### notice` listing them. The
 * "first approval-gated wins" rule respects the model's emit order
 * (writes typically precede the edits that depend on them) without
 * asking the model to re-plan.
 */
export interface BatchTrimResult {
  kept: ToolCallPayload;
  /** Calls dropped for the model to retry, in batch-index order. */
  dropped: ToolCallPayload[];
  /**
   * Calls dropped because the turn's policy (plan mode, the fusion
   * orchestrator gate) would have refused them anyway, each with the
   * gate that would have refused it. Not to be retried: re-emitting
   * them earns the same refusal.
   */
  refused: Array<{ call: ToolCallPayload; reason: string }>;
  /** Original batch size before trimming. Always >= 2. */
  originalSize: number;
}


/**
 * The turn policy the trim consults before it picks a survivor.
 *
 * `refusedBy` runs the same predicates the batch executor's gates run
 * at dispatch (`wouldRefuse` in `plan-mode.ts` /
 * `fusion-orchestrator-mode.ts`) and names the gate, so the trim and
 * the gate cannot disagree about a call. `preferTool` names the call
 * that wins over emit order when it is present — on an orchestrator
 * turn, `fusion.delegate`: the fan-out is what the turn exists to do,
 * and a `mkdir` emitted ahead of it must not be the one that survives
 * only to be refused (run 14: nine minutes of generation redone).
 */
export interface BatchTrimPolicy {
  /** The gate that would refuse `tool`, or `null` when it may run. */
  refusedBy?: (tool: string) => string | null;
  preferTool?: string;
}


/** The fan-out tool an orchestrator turn prefers to keep. */
export const ORCHESTRATOR_PREFERRED_TOOL = "fusion.delegate";


export const TRIM_REFUSED_BY_PLAN_MODE = "refused by plan mode";

export const TRIM_REFUSED_BY_FUSION_GATE = "refused by the fusion gate";


/**
 * Build the trim policy from the step's dependencies — the same
 * getters the batch context carries (`isPlanMode`, `isFusionOrchestrator`
 * and the registry), read at trim time so a mode flipped mid-turn is
 * honoured the way the gates honour it. Plan mode is named first when
 * both would refuse, in the order the gates run.
 */
export function turnPolicyForTrim(
  deps: Pick<
    StepDependencies,
    "registry" | "isPlanMode" | "isFusionOrchestrator"
  >,
): BatchTrimPolicy {
  const planMode = deps.isPlanMode?.() ?? false;
  const orchestrator = deps.isFusionOrchestrator?.() ?? false;
  if (!planMode && !orchestrator) return {};
  const ctx = { registry: deps.registry };
  return {
    refusedBy: (tool) =>
      planMode && planModeWouldRefuse(tool, ctx)
        ? TRIM_REFUSED_BY_PLAN_MODE
        : orchestrator && fusionGateWouldRefuse(tool, ctx)
          ? TRIM_REFUSED_BY_FUSION_GATE
          : null,
    ...(orchestrator ? { preferTool: ORCHESTRATOR_PREFERRED_TOOL } : {}),
  };
}


/**
 * Pick the survivor. Calls the turn policy would refuse are set aside
 * first, so the kept call is one that can actually run; among the rest,
 * `policy.preferTool` wins when present, else the first approval-gated
 * call in emit order (writes typically precede the edits that depend on
 * them). When every approval-gated call would be refused, the first one
 * is kept anyway: it earns the gate's own refusal, which is the text
 * that tells the model what to do instead.
 */
export function trimBatchToFirstApprovalGated(
  batch: ToolCallBatch,
  policy: BatchTrimPolicy = {},
): BatchTrimResult | null {
  const calls = batch.calls;
  const isGated = (call: ToolCallPayload): boolean =>
    resourceClassFor(call.tool) === "approval_gated";
  if (!calls.some(isGated)) return null;
  const refusedIdx = new Map<number, string>();
  if (policy.refusedBy) {
    calls.forEach((call, idx) => {
      const reason = policy.refusedBy!(call.tool);
      if (reason !== null) refusedIdx.set(idx, reason);
    });
  }
  const runnable = (idx: number): boolean => !refusedIdx.has(idx);
  let keptIdx = -1;
  if (policy.preferTool !== undefined) {
    keptIdx = calls.findIndex(
      (call, idx) => call.tool === policy.preferTool && runnable(idx),
    );
  }
  if (keptIdx === -1) {
    keptIdx = calls.findIndex((call, idx) => isGated(call) && runnable(idx));
  }
  if (keptIdx === -1) {
    // Every gated call is refused: keep the first and let the gate
    // speak — its refusal is the instruction, and the notice names the
    // rest as refused so the model does not retry them one by one.
    keptIdx = calls.findIndex(isGated);
    refusedIdx.delete(keptIdx);
  }
  const kept = calls[keptIdx]!;
  const dropped: ToolCallPayload[] = [];
  const refused: BatchTrimResult["refused"] = [];
  calls.forEach((call, idx) => {
    if (idx === keptIdx) return;
    const reason = refusedIdx.get(idx);
    if (reason === undefined) dropped.push(call);
    else refused.push({ call, reason });
  });
  return { kept, dropped, refused, originalSize: calls.length };
}


/**
 * Render the `### notice` text the model sees on the next step after a
 * trim. The wording is deliberately concrete: it lists the dropped tool
 * names so the model can re-emit them in batch-index order as length-1
 * arrays without re-deriving them from scratch. Mentioning that
 * approval-gated tools must be solo reinforces the rule without
 * triggering the prompt-rule regression we saw earlier (the message
 * lives in the variable tail of the next step's prompt only — never the
 * stable prefix).
 */
export function formatBatchTrimNotice(trim: BatchTrimResult): string {
  const names = (calls: readonly ToolCallPayload[]): string =>
    calls.map((call) => `\`${call.tool}\``).join(", ");
  const parts = [
    `Your previous emission contained ${trim.originalSize} calls including approval-gated tools that must be solo (length-1 array). The runtime auto-executed \`${trim.kept.tool}\`.`,
  ];
  if (trim.dropped.length > 0) {
    parts.push(
      `Dropped from the batch — retry: ${names(trim.dropped)}. Retry them now, one per step, each as a length-1 array. Do not re-batch them.`,
    );
  }
  if (trim.refused.length > 0) {
    // Grouped by gate, so the model reads the same rule the gate's own
    // refusal states — and does not retry a call that earns it again.
    const byReason = new Map<string, ToolCallPayload[]>();
    for (const { call, reason } of trim.refused) {
      byReason.set(reason, [...(byReason.get(reason) ?? []), call]);
    }
    const groups = [...byReason]
      .map(([reason, calls]) => `${names(calls)} (${reason})`)
      .join("; ");
    parts.push(
      `Dropped because this turn's policy would refuse them — do not retry: ${groups}.`,
    );
  }
  return parts.join(" ");
}


/**
 * Render the `### notice` text the model sees on the next step after an
 * oversized pure-read batch was mechanically split into bounded waves.
 * Unlike the trim notice, nothing was dropped — every call ran, just in
 * waves of at most `cap` instead of one all-at-once fan-out. The notice
 * exists so the model understands the array was honoured in full and
 * does not re-emit the calls.
 */
export function formatWaveSplitNotice(
  originalSize: number,
  cap: number,
  waveCount: number,
): string {
  return `Your previous emission contained ${originalSize} reads that exceeded the parallel-call cap of ${cap}. The runtime executed all of them in ${waveCount} bounded wave${waveCount === 1 ? "" : "s"} — nothing was dropped. Do not re-emit those calls.`;
}


export type ExecuteBatchArgs = Parameters<typeof executeBatch>;

export type BatchOutcome = Awaited<ReturnType<typeof executeBatch>>;


/**
 * Run a batch one call at a time, strictly in emitted order: each call is
 * dispatched only after the previous one has settled, whatever its
 * resource class. `executeBatch` groups by class and runs the groups
 * concurrently, which is right for fan-out and wrong for "write the
 * file, then edit it, then read it back" — so each call goes through its
 * own length-1 `executeBatch` (same plan-mode / fusion / loop gates, same
 * result folding as a solo step) and the indices are mapped back.
 *
 * Used for a batch holding approval-gated calls that would not prompt
 * (`batchRunsUnattended`). An abort stops the sequence: the call in
 * flight settles as `executeBatch` settles it and every later call is
 * marked cancelled.
 */
export async function executeCallsInOrder(
  inputs: ExecuteBatchArgs[0],
  registry: ExecuteBatchArgs[1],
  ctx: ExecuteBatchArgs[2],
): Promise<BatchOutcome> {
  const batchSize = inputs.length;
  const results: BatchOutcome["results"] = [];
  const loopSignals: BatchOutcome["loopSignals"] = [];
  let cancelled = false;
  for (const input of inputs) {
    if (cancelled || ctx.signal.aborted) {
      cancelled = true;
      results.push({
        batchIndex: input.batchIndex,
        call: input.call,
        resourceClass: input.resourceClass,
        durationMs: 0,
        cancelled: true,
      });
      continue;
    }
    const { onCallStarted, onCallFinished } = ctx;
    const one = await executeBatch([{ ...input, batchIndex: 0 }], registry, {
      ...ctx,
      ...(onCallStarted
        ? {
            onCallStarted: () =>
              onCallStarted({ batchIndex: input.batchIndex, batchSize }),
          }
        : {}),
      ...(onCallFinished
        ? {
            onCallFinished: (info) =>
              onCallFinished({
                ...info,
                batchIndex: input.batchIndex,
                batchSize,
              }),
          }
        : {}),
    });
    results.push({ ...one.results[0]!, batchIndex: input.batchIndex });
    loopSignals.push(...one.loopSignals);
    if (one.cancelled) cancelled = true;
  }
  return { results, cancelled, loopSignals };
}


/**
 * What `executeWithApprovalBarriers` did with a batch, filled in as it
 * runs — the step reads it for the `batch_approval_barriers` event, the
 * metric and the next step's notice.
 */
export interface ApprovalBarrierReport {
  /** Runs of batchable calls that completed. */
  waves: number;
  /** Approval-gated calls that ran, each alone. */
  barriers: number;
  /** Calls that ran, with the payload the model emitted. */
  retained: number;
  /** Calls that never ran, in batch-index order. */
  invalidated: ToolCallPayload[];
  /** The gated call that stopped the batch, or `null` when none did. */
  stoppedBy: {
    call: ToolCallPayload;
    batchIndex: number;
    cause: ApprovalBarrierStopCause;
  } | null;
  /** The turn was cancelled while the batch ran. */
  cancelled: boolean;
}

export function emptyApprovalBarrierReport(): ApprovalBarrierReport {
  return {
    waves: 0,
    barriers: 0,
    retained: 0,
    invalidated: [],
    stoppedBy: null,
    cancelled: false,
  };
}

/**
 * Cut a batch into the order it runs behind approval barriers: each
 * approval-gated call is a segment of its own, and the batchable calls
 * between two of them form one segment, in emitted order.
 */
export function approvalBarrierSegments(
  inputs: readonly BatchCallInput[],
): BatchCallInput[][] {
  const segments: BatchCallInput[][] = [];
  let run: BatchCallInput[] = [];
  for (const input of inputs) {
    if (input.resourceClass !== "approval_gated") {
      run.push(input);
      continue;
    }
    if (run.length > 0) segments.push(run);
    run = [];
    segments.push([input]);
  }
  if (run.length > 0) segments.push(run);
  return segments;
}

/**
 * Run a batch holding approval-gated calls that could prompt, behind
 * approval barriers (issue #109). The trim used to keep the first gated
 * call and drop the rest, so `[write, read it back]` cost a second
 * inference to emit the read again — and with "ask first", one card per
 * re-emitted call.
 *
 * Segments run in emitted order (`approvalBarrierSegments`). A run of
 * batchable calls goes through `executeBatch` whole — class-aware
 * concurrency, the same gates — and settles before the next segment
 * starts. A gated call goes through its own length-1 `executeBatch`, so
 * it asks exactly as a solo call does; a later gated call is a barrier
 * of its own and asks its own question. Once a gated call is not
 * approved or comes back with an error, nothing after it runs: each of
 * those calls gets an error result naming the call that stopped it, and
 * no question is put for them — a declined write is not asked about
 * again through a call that was queued behind it. An abort marks every
 * call not yet run as cancelled, as `executeBatch` does.
 *
 * Batch indices and `batchSize` are the emitted ones throughout, so the
 * results, the events and the transcript line up with the calls.
 */
export async function executeWithApprovalBarriers(
  inputs: ExecuteBatchArgs[0],
  registry: ExecuteBatchArgs[1],
  ctx: ExecuteBatchArgs[2],
  report: ApprovalBarrierReport,
): Promise<BatchOutcome> {
  const batchSize = inputs.length;
  const results: BatchOutcome["results"] = [];
  const loopSignals: BatchOutcome["loopSignals"] = [];
  let cancelled = false;
  for (const segment of approvalBarrierSegments(inputs)) {
    if (ctx.signal.aborted) cancelled = true;
    const stop = report.stoppedBy;
    if (cancelled || stop !== null) {
      for (const input of segment) {
        report.invalidated.push(input.call);
        if (cancelled || stop === null) {
          results.push({
            batchIndex: input.batchIndex,
            call: input.call,
            resourceClass: input.resourceClass,
            durationMs: 0,
            cancelled: true,
          });
          continue;
        }
        const notRun = notRunBehindBarrierResult(input.call, stop, batchSize);
        ctx.onCallStarted?.({ batchIndex: input.batchIndex, batchSize });
        results.push({
          batchIndex: input.batchIndex,
          call: input.call,
          resourceClass: input.resourceClass,
          compressed: notRun,
          durationMs: 0,
          cancelled: false,
        });
        ctx.onCallFinished?.({
          batchIndex: input.batchIndex,
          batchSize,
          result: notRun,
          durationMs: 0,
        });
      }
      continue;
    }
    // `executeBatch` keys its slots by `batchIndex`, so the segment runs
    // under local indices and every callback and slot is mapped back.
    const globalIndex = (local: number): number =>
      segment[local]!.batchIndex;
    const { onCallStarted, onCallFinished } = ctx;
    const ran = await executeBatch(
      segment.map((input, local) => ({ ...input, batchIndex: local })),
      registry,
      {
        ...ctx,
        ...(onCallStarted
          ? {
              onCallStarted: (info) =>
                onCallStarted({
                  batchIndex: globalIndex(info.batchIndex),
                  batchSize,
                }),
            }
          : {}),
        ...(onCallFinished
          ? {
              onCallFinished: (info) =>
                onCallFinished({
                  ...info,
                  batchIndex: globalIndex(info.batchIndex),
                  batchSize,
                }),
            }
          : {}),
      },
    );
    loopSignals.push(...ran.loopSignals);
    ran.results.forEach((slot, local) => {
      results.push({ ...slot, batchIndex: globalIndex(local) });
      if (slot.cancelled) report.invalidated.push(slot.call);
      else report.retained += 1;
    });
    if (ran.cancelled) {
      cancelled = true;
      continue;
    }
    const first = segment[0]!;
    if (first.resourceClass !== "approval_gated") {
      report.waves += 1;
      continue;
    }
    report.barriers += 1;
    const result = ran.results[0]?.compressed;
    if (result === undefined || result.status !== "ok") {
      report.stoppedBy = {
        call: first.call,
        batchIndex: first.batchIndex,
        cause: approvalBarrierStopCause(result),
      };
    }
  }
  report.cancelled = cancelled || ctx.signal.aborted;
  return { results, cancelled: report.cancelled, loopSignals };
}

/**
 * Why a gated call stopped its batch. Not approved when someone was
 * asked and said no (the call's approval ledger holds a denial) or the
 * gate refused it without asking (`ApprovalDeniedError`, an MCP tool's
 * `approvalDenied`); anything else that did not come back `ok` failed.
 */
function approvalBarrierStopCause(
  result: CompressedToolResult | undefined,
): ApprovalBarrierStopCause {
  if (result === undefined) return "failed";
  if (result.approvals?.some((record) => record.verdict === "denied")) {
    return "not_approved";
  }
  if (
    result.details.errorName === "ApprovalDeniedError" ||
    result.details.approvalDenied === true
  ) {
    return "not_approved";
  }
  return "failed";
}

/** What a stopped barrier did, as the rest of a sentence. */
function approvalBarrierStopPhrase(cause: ApprovalBarrierStopCause): string {
  return cause === "not_approved" ? "was not approved" : "failed";
}

/**
 * The result a call queued behind a stopped barrier gets in place of
 * running: an error naming the gated call that stopped it, so the
 * transcript, the trace and the host each show why it did not run.
 */
function notRunBehindBarrierResult(
  call: ToolCallPayload,
  stop: NonNullable<ApprovalBarrierReport["stoppedBy"]>,
  batchSize: number,
): CompressedToolResult {
  return compressToolResult({
    tool: call.tool,
    status: "error",
    output: `not run: it came after \`${stop.call.tool}\` (call ${stop.batchIndex + 1} of ${batchSize}) in the same batch, and that call ${approvalBarrierStopPhrase(stop.cause)}`,
    details: {
      notRun: true,
      blockedBy: stop.call.tool,
      blockedByIndex: stop.batchIndex,
      blockedCause: stop.cause,
    },
  });
}

/**
 * Render the `### notice` text the model sees on the next step after a
 * batch run behind approval barriers stopped early, or `null` when
 * nothing was left unrun. It names the call that stopped the batch, why,
 * and every call that never ran, so the model decides about each one
 * instead of re-emitting the batch — and is told not to ask for a call
 * that was not approved again on its own initiative.
 */
export function formatApprovalBarrierNotice(
  report: ApprovalBarrierReport,
  originalSize: number,
): string | null {
  const stop = report.stoppedBy;
  if (stop === null || report.invalidated.length === 0) return null;
  const names = report.invalidated.map((call) => `\`${call.tool}\``).join(", ");
  const next =
    stop.cause === "not_approved"
      ? "Do not ask for the call that was not approved again unless the user asks for it; re-emit any of the others only if it still makes sense without it."
      : "Read its error first; re-emit any of the others only if it still makes sense after that failure.";
  return [
    `Your previous emission contained ${originalSize} calls including approval-gated tools. The runtime ran them in order, each approval-gated call on its own, and stopped at \`${stop.call.tool}\` (call ${stop.batchIndex + 1} of ${originalSize}), which ${approvalBarrierStopPhrase(stop.cause)}.`,
    `Not run: ${names} — they came after it and may depend on it.`,
    next,
  ].join(" ");
}

/**
 * The transcript counts a stream consumer cut the completion short over
 * (`CompletionEarlyStop`). Stands in when the detector finds nothing in
 * the free text — the profile's reasoning extraction can strip text the
 * consumer judged as plain content — because the stream was ended on
 * those lines, and whatever came back is not an answer to deliver.
 */
export function fabricationFromEarlyStop(
  completion: CompletionResult,
): FabricatedToolTranscript | null {
  const stop = completion.earlyStop;
  return stop?.reason === "fabricated_transcript"
    ? { calls: stop.calls, results: stop.results }
    : null;
}


/**
 * Preflight for wave splitting (issue #111): does the call's `args`
 * satisfy the tool's registered JSON schema? The schema is taken from
 * the effective descriptor list first (covers dynamic MCP descriptors
 * carrying server-supplied `inputSchema`), falling back to the static
 * default-args map. A tool with no registered schema passes — there is
 * nothing to validate against. An unsupported schema construct fails
 * closed (no wave split) so we never execute a call the runtime cannot
 * vouch for.
 */
export function callArgsSchemaValid(
  call: ToolCallPayload,
  descriptors: readonly ToolDescriptor[],
): boolean {
  const descriptor = descriptors.find((d) => d.name === call.tool);
  const schema =
    descriptor?.argsJsonSchema ?? getDefaultArgsJsonSchema(call.tool);
  if (!schema) return true;
  try {
    return validateJsonSchemaValue(call.args, schema);
  } catch {
    return false;
  }
}
