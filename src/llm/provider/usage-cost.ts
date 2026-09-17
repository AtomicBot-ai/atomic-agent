import type { CompletionUsage } from "./completion-types.js";
import type { ResolvedModel } from "./model-resolver.js";

/**
 * Estimated spend of one completion, in USD, from its usage and the
 * model's per-million-token prices.
 *
 * Cached prompt tokens are a subset of `promptTokens`: they are billed at
 * the model's `cacheRead` rate when the catalog or the operator names
 * one, and at the plain input rate otherwise (an unknown discount is not
 * assumed). A cache-write premium is not modelled — services do not
 * report which tokens were written, only which were read.
 */
export function estimateUsageCostUsd(
  usage: CompletionUsage,
  pricing: NonNullable<ResolvedModel["pricing"]>,
): number {
  const cached = Math.min(
    Math.max(0, usage.cachedTokens ?? 0),
    Math.max(0, usage.promptTokens),
  );
  const cacheReadRate = pricing.cacheRead ?? pricing.input;
  const uncached = usage.promptTokens - cached;
  return (
    (uncached / 1_000_000) * pricing.input +
    (cached / 1_000_000) * cacheReadRate +
    (usage.completionTokens / 1_000_000) * pricing.output
  );
}
