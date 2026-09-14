import type { CompletionUsage } from "../llm/provider/completion-types.js";
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
}

interface TurnBucket {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
  sawUsage: boolean;
  sawCachedUsage: boolean;
  sawPricedUsage: boolean;
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
   */
  begin(sessionId: string): void {
    this.buckets.set(sessionId, {
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      sawUsage: false,
      sawCachedUsage: false,
      sawPricedUsage: false,
    });
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
  }): void {
    const bucket = this.buckets.get(params.sessionId);
    if (!bucket) return;
    const { usage } = params;
    if (!usage) return;

    bucket.sawUsage = true;
    bucket.promptTokens += usage.promptTokens;
    bucket.completionTokens += usage.completionTokens;
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
    if (!bucket || !bucket.sawUsage) return {};
    return {
      promptTokens: bucket.promptTokens,
      completionTokens: bucket.completionTokens,
      ...(bucket.sawCachedUsage ? { cachedTokens: bucket.cachedTokens } : {}),
      ...(bucket.sawPricedUsage ? { costUsd: bucket.costUsd } : {}),
    };
  }
}
