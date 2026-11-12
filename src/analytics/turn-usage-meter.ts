import type { CompletionTiming, CompletionUsage } from "../llm/provider/completion-types.js";
import type { ResolvedModel } from "../llm/provider/model-resolver.js";
import { estimateUsageCostUsd } from "../llm/provider/usage-cost.js";

/**
 * Token + spend totals accumulated for a single turn.
 *
 * A turn is one human message and every LLM call it triggers — the
 * agent loop's own steps plus any sub-runner (reflection, link-gen,
 * vote, rewriter, distill) that ran while it was in flight. Callers
 * read this at the end of the turn to attach non-content shape metrics
 * to `message_sent`.
 *
 * `costUsd` is only meaningful when the model carries pricing. Local
 * runners (llama.cpp) have none, so their turns accumulate tokens with
 * a zero cost — which is why `snapshot()` reports `costUsd` as
 * undefined rather than 0 unless at least one priced call landed.
 */
export interface TurnUsageSnapshot {
  promptTokens?: number;
  completionTokens?: number;
  /**
   * Prompt tokens the services served from a prompt cache, summed over
   * the turn's calls. Present only when at least one call reported the
   * figure: a provider that says nothing about caching yields no key,
   * which is different from one that reports zero hits.
   */
  cachedTokens?: number;
  costUsd?: number;
  /**
   * The provider link that served the turn's last completion: after a
   * cross-provider fallover this is the fallback, not the configured
   * active provider (ATO-277). Absent when no completion was served.
   */
  servedProviderId?: string;
  /**
   * How many of the turn's completions were served by a link other than
   * the one the turn was meant for (`begin`'s `intendedProviderId`).
   * Present only when that provider was given and a completion landed.
   */
  fallbackCalls?: number;
  /**
   * How long the turn's streamed completions spent generating, and the
   * output tokens those same completions produced (ATO-1186). Read as a
   * pair: `completionTokens / durationMs` is the turn's reply speed. Only
   * completions with a measured generation time count, so a sub-call that
   * was not timed never skews the speed. Absent when none was timed.
   */
  generation?: { completionTokens: number; durationMs: number };
}

interface TurnBucket {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
  sawUsage: boolean;
  sawCachedUsage: boolean;
  sawPricedUsage: boolean;
  intendedProviderId: string | undefined;
  servedProviderId: string | undefined;
  fallbackCalls: number;
  generatedTokens: number;
  generationMs: number;
}

/**
 * Accumulates completion usage across the calls that make up one turn.
 *
 * Providers report usage per call, but a turn is many calls, so the
 * numbers have to be summed somewhere. This meter is that place: the
 * provider seam records into it, the analytics seam reads from it.
 *
 * Buckets are keyed by session. The turn controller serializes turns
 * *within* a session but runs different sessions concurrently — the
 * sidecar, the Telegram channel and the task runner all drive turns
 * independently — so a single shared bucket would bill one session's
 * tokens to whichever session happened to finish first.
 *
 * Calls that arrive with no turn open for their session (background
 * work during bootstrap, scheduler-driven turns, sub-runners firing
 * after their turn closed) are dropped rather than misfiled.
 */
export class TurnUsageMeter {
  private readonly buckets = new Map<string, TurnBucket>();

  /**
   * Open a fresh bucket for `sessionId`, discarding any half-finished
   * one left behind by a turn that never reached `snapshot()`.
   * `intendedProviderId` is the provider the turn should run on (its
   * pin, else the active one); completions served elsewhere count as
   * fallbacks.
   */
  begin(sessionId: string, intendedProviderId?: string): void {
    this.buckets.set(sessionId, {
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      sawUsage: false,
      sawCachedUsage: false,
      sawPricedUsage: false,
      intendedProviderId,
      servedProviderId: undefined,
      fallbackCalls: 0,
      generatedTokens: 0,
      generationMs: 0,
    });
  }

  /**
   * Note which provider link served one completion of the open turn for
   * `sessionId`, whether or not it reported usage. No-ops when that
   * session has no turn open.
   */
  recordServed(sessionId: string, providerId: string): void {
    const bucket = this.buckets.get(sessionId);
    if (!bucket) return;
    bucket.servedProviderId = providerId;
    if (
      bucket.intendedProviderId !== undefined &&
      providerId !== bucket.intendedProviderId
    ) {
      bucket.fallbackCalls += 1;
    }
  }

  /**
   * Fold one completion's usage into the open turn for `sessionId`.
   * No-ops when that session has no turn open, or when the provider
   * reported no usage block at all — absent data must stay absent
   * rather than become a zero.
   */
  record(params: {
    sessionId: string;
    usage?: CompletionUsage;
    model?: ResolvedModel;
    /**
     * How long this completion spent generating (`generationMsFor`).
     * Only a positive figure with output tokens counts toward the turn's
     * reply speed (ATO-1186).
     */
    generationMs?: number;
  }): void {
    const bucket = this.buckets.get(params.sessionId);
    if (!bucket) return;
    const { usage } = params;
    if (!usage) return;

    bucket.sawUsage = true;
    bucket.promptTokens += usage.promptTokens;
    bucket.completionTokens += usage.completionTokens;
    if (
      params.generationMs !== undefined &&
      Number.isFinite(params.generationMs) &&
      params.generationMs > 0 &&
      usage.completionTokens > 0
    ) {
      bucket.generationMs += params.generationMs;
      bucket.generatedTokens += usage.completionTokens;
    }
    if (usage.cachedTokens !== undefined) {
      bucket.sawCachedUsage = true;
      bucket.cachedTokens += usage.cachedTokens;
    }

    const pricing = params.model?.pricing;
    if (!pricing) return;
    bucket.sawPricedUsage = true;
    bucket.costUsd += estimateUsageCostUsd(usage, pricing);
  }

  /**
   * Open a bucket for `sessionId` unless one is already open. For turns
   * that do not come through `runTurn` (the sidecar's `executeTurn`, the
   * scheduler), so a fusion turn's cap (ATO-947) still sees the
   * orchestrator's spend; the caller reads it as a delta from its own
   * baseline, because such a bucket is never closed by `snapshot`.
   */
  ensureOpen(sessionId: string): void {
    if (!this.buckets.has(sessionId)) this.begin(sessionId);
  }

  /**
   * The open turn's priced spend so far, without closing it: `0` while
   * nothing priced has landed, `undefined` when no turn is open. Read
   * by the fusion turn cap (ATO-947) between fan-outs.
   */
  peekCostUsd(sessionId: string): number | undefined {
    return this.buckets.get(sessionId)?.costUsd;
  }

  /**
   * Close the open turn for `sessionId` and report its totals. Fields
   * the turn could not measure are omitted entirely: a provider that
   * never reported usage yields `{}`, and an unpriced model yields
   * token counts with no `costUsd`.
   *
   * Always releases the bucket, so a turn that throws before reporting
   * cannot leak one — callers snapshot on the failure path too.
   */
  snapshot(sessionId: string): TurnUsageSnapshot {
    const bucket = this.buckets.get(sessionId);
    this.buckets.delete(sessionId);
    if (!bucket) return {};
    const served: TurnUsageSnapshot =
      bucket.servedProviderId === undefined
        ? {}
        : {
            servedProviderId: bucket.servedProviderId,
            ...(bucket.intendedProviderId !== undefined
              ? { fallbackCalls: bucket.fallbackCalls }
              : {}),
          };
    if (!bucket.sawUsage) return served;
    return {
      promptTokens: bucket.promptTokens,
      completionTokens: bucket.completionTokens,
      ...(bucket.sawCachedUsage ? { cachedTokens: bucket.cachedTokens } : {}),
      ...(bucket.sawPricedUsage ? { costUsd: bucket.costUsd } : {}),
      ...(bucket.generationMs > 0
        ? {
            generation: {
              completionTokens: bucket.generatedTokens,
              durationMs: Math.round(bucket.generationMs),
            },
          }
        : {}),
      ...served,
    };
  }
}

/**
 * How long one streamed completion spent generating its output
 * (ATO-1186). A local llama-server measures its own decode time
 * (`timing.predictedMs`), which leaves out prompt processing, so that
 * figure wins. Every other provider reports none; the time from the
 * stream's first chunk to its end (`streamMs`, measured by the
 * streaming seam) stands in. `undefined` when neither is known.
 */
export function generationMsFor(
  result: { timing?: CompletionTiming },
  streamMs: number | undefined,
): number | undefined {
  const predicted = result.timing?.predictedMs ?? 0;
  if (Number.isFinite(predicted) && predicted > 0) return predicted;
  if (streamMs !== undefined && Number.isFinite(streamMs) && streamMs > 0) return streamMs;
  return undefined;
}

/**
 * The usage a completion contributes to its turn: the provider's own
 * `usage` block when it sent one (cloud providers), otherwise the token
 * counts in its `timing` (a local llama-server reports no `usage` block,
 * only `timings`: the whole prompt with the reused prefix, and the
 * generated tokens). A completion with neither, or with zero counts,
 * contributes nothing, so absent data stays absent.
 */
export function completionUsageForTurn(result: {
  usage?: CompletionUsage;
  timing?: CompletionTiming;
  cacheHitTokens?: number;
}): CompletionUsage | undefined {
  if (result.usage) return result.usage;
  const promptTokens = result.timing?.promptTokens ?? 0;
  const completionTokens = result.timing?.predictedTokens ?? 0;
  if (promptTokens <= 0 && completionTokens <= 0) return undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(result.cacheHitTokens !== undefined && result.cacheHitTokens > 0 ? { cachedTokens: result.cacheHitTokens } : {}),
  };
}
