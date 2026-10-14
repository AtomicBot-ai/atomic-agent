import { contextUsageFromPrompt } from "../session/context-usage.js";
import type { LlmStreamParams } from "../agent/step/step-contract.js";
import type { CompactionEvent, CompactionStepOptions } from "../agent/compaction-control.js";
import type { CompactionConfig } from "../config/agent/compaction-config.js";
import type { CompletionResult } from "../llm/provider/completion-types.js";
import { buildPrompt } from "../prompt/build-prompt.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import type { CompactionPlan } from "../prompt/plan-compaction.js";
import { estimateTokens } from "../prompt/token-budget.js";
import { compactionBoundaryHash, validSessionCompaction, type CompactionResult } from "../session/session-compaction.js";
import type { SessionState } from "../session/session-state.js";
import { prepareCompactionSource, type CompactionSource } from "./context-compaction-chunks.js";
import { buildExtractiveSummary } from "./compaction-extractive.js";
import { chooseCompactionMethod, type CompactionRouteFacts } from "./compaction-mode.js";
import { modelSummaryFailure, summarizeWithModel, type ModelSummaryRoute, type ModelSummaryTally } from "./context-compaction-model.js";

export interface CompactionRunnerDependencies {
  complete(params: LlmStreamParams): Promise<CompletionResult>;
  route(sessionId: string, providerId?: string): ModelSummaryRoute & CompactionRouteFacts;
  sideCallSlotId(): number;
  costOf?(result: CompletionResult, providerId: string): number | undefined;
  persist(state: SessionState, inTurn: boolean): void;
  emit(event: CompactionEvent): void;
}

export interface CompactionRunOptions extends CompactionStepOptions {
  inTurn: boolean;
  /** Under `auto`, skip the model: a model summary on this route already ran out of time. */
  preferExtractive?: boolean;
}

/**
 * One atomic checkpoint; intermediate chunk summaries never escape this function.
 * `timedOut` says a model summary ran out of time, including when `auto`
 * then published an extractive checkpoint in its place.
 */
export async function runContextCompaction(
  input: BuildPromptInput,
  plan: CompactionPlan,
  config: CompactionConfig,
  options: CompactionRunOptions,
  deps: CompactionRunnerDependencies,
): Promise<{ state: SessionState; result: CompactionResult; timedOut?: boolean }> {
  const state = input.session;
  const tally: ModelSummaryTally = { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, calls: 0,
    chunkCount: 0, totalTimeoutMs: config.timeoutMs };
  const emit = (event: CompactionEvent) => {
    try { deps.emit(event); } catch { /* Observers cannot roll back a saved checkpoint. */ }
  };
  let modelFailure: { timedOut: boolean; message: string } | undefined;
  let fellBack = false;
  emit({ type: "compaction_started", sessionId: state.id, reason: plan.reason, tokensBefore: plan.tokensBefore });
  try {
    options.signal.throwIfAborted();
    const route = deps.route(state.id, options.providerId);
    const prompt = buildPrompt(input);
    const previous = validSessionCompaction(state)?.summary ?? "";
    // Serialize original records, including bodies that the prompt renderer clipped long ago.
    // Fragment oversized individual records instead of silently dropping their suffix.
    let prepared: CompactionSource | undefined;
    const source = () => prepared ??= prepareCompactionSource(state.turns, plan.from, plan.through,
      input.modelMode?.mode === "cloud" ? state.cloudContext?.entries : undefined);
    const extractive = () => buildExtractiveSummary(state.turns, plan.from, plan.through,
      { maxTokens: plan.summaryMaxTokens, previousSummary: previous });
    const method = options.preferExtractive && config.mode === "auto"
      ? "extractive"
      : chooseCompactionMethod(config.mode, route, () => estimateTokens(source().text));
    let summary: string;
    let model: string | null = null;
    if (method === "extractive") {
      summary = extractive();
    } else {
      try {
        ({ summary, model } = await summarizeWithModel({
          input, prompt, plan, config, route, previous, source: source(), signal: options.signal, tally, emit,
          complete: deps.complete, sideCallSlotId: deps.sideCallSlotId,
          ...(deps.costOf ? { costOf: deps.costOf } : {}),
        }));
      } catch (error) {
        if (options.signal.aborted) throw error;
        modelFailure = modelSummaryFailure(error, tally, config);
        // `auto` never ends on the old drop-records fallback when it can extract instead.
        if (config.mode !== "auto") throw error;
        fellBack = true;
        summary = extractive();
      }
    }
    const kind = method === "extractive" || fellBack ? "extractive" as const : undefined;
    const { usage, calls, costUsd } = tally;
    const next: SessionState = { ...state, compaction: {
      version: 1, summary, coveredThrough: plan.through,
      boundaryHash: compactionBoundaryHash(state.turns[plan.through - 1]!),
      createdAt: Date.now(), reason: plan.reason, model: kind ? null : model,
      ...(kind ? { kind } : {}),
      tokensBefore: plan.tokensBefore, tokensAfter: 0,
      usage, calls, ...(costUsd !== undefined ? { costUsd } : {}),
    } };
    // A semantic checkpoint supersedes the old mechanical cut. Their boundaries differ.
    delete next.conversationPackStart;
    delete next.compactionWarning;
    const rebuilt = buildPrompt({ ...input, session: next });
    const after = rebuilt.compactionBudget!.activeTokens;
    if (after >= plan.tokensBefore || after > plan.targetTokens) throw new Error("The summary did not reduce context to the target budget.");
    next.compaction!.tokensAfter = after;
    next.contextUsage = contextUsageFromPrompt(rebuilt);
    options.signal.throwIfAborted();
    if (!options.ephemeral) deps.persist(next, options.inTurn);
    const result: CompactionResult = { status: "compacted", reason: plan.reason, tokensBefore: plan.tokensBefore, tokensAfter: after,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(fellBack && modelFailure ? { message: `The model summary failed (${modelFailure.message.replace(/[.!?]+$/, "")}); an extractive summary was used instead.` } : {}),
    };
    emit({ type: "compaction_completed", sessionId: state.id, result, usage, calls, contextUsage: next.contextUsage });
    return { state: next, result, ...(modelFailure?.timedOut ? { timedOut: true } : {}) };
  } catch (error) {
    const failure = options.signal.aborted ? undefined : modelFailure ?? modelSummaryFailure(error, tally, config);
    // A model failure is the cause even when the extractive checkpoint after it was refused.
    const message = failure && fellBack
      ? `${failure.message} The extractive fallback also failed: ${error instanceof Error ? error.message : String(error)}`
      : failure?.message ?? (error instanceof Error ? error.message : String(error));
    const result: CompactionResult = {
      status: options.signal.aborted ? "cancelled" : "failed", reason: plan.reason,
      tokensBefore: plan.tokensBefore, ...(tally.costUsd !== undefined ? { costUsd: tally.costUsd } : {}),
      message,
    };
    emit({ type: "compaction_failed", sessionId: state.id, result, usage: tally.usage, calls: tally.calls });
    return { state, result, ...(failure?.timedOut ? { timedOut: true } : {}) };
  }
}
