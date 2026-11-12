import type { CompletionUsage } from "./completion-types.js";
import type { ResolvedModel } from "./model-resolver.js";

/**
 * Estimated spend of one completion, in USD, from its usage and the
 * model's per-million-token prices.
 *
 * Cached prompt tokens are a subset of `promptTokens`: they are billed at
 * the model's `cacheRead` rate when the catalog or the operator names
 * one, and at the plain input rate otherwise (an unknown discount is not
 * assumed).
 *
 * Prompt tokens written to the cache are priced at the model's
 * `cacheWrite` rate when the service reports them (`cacheWriteTokens`,
 * Kimi's `prompt_tokens_details.cache_write_tokens`) and a rate is
 * known; otherwise they stay in the plain-input share, as before. A
 * service that reports no write count is billed exactly as it was
 * (ATO-912).
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
  // Disjoint from the cached share: hits, writes and the uncached rest
  // sum to the prompt (Kimi documents it so).
  const written = Math.min(
    Math.max(0, usage.cacheWriteTokens ?? 0),
    Math.max(0, usage.promptTokens - cached),
  );
  const cacheWriteRate = pricing.cacheWrite ?? pricing.input;
  const uncached = usage.promptTokens - cached - written;
  return (
    (uncached / 1_000_000) * pricing.input +
    (cached / 1_000_000) * cacheReadRate +
    (written / 1_000_000) * cacheWriteRate +
    (usage.completionTokens / 1_000_000) * pricing.output
  );
}

/**
 * A spend estimate in plain dollars: two decimals, or four below one
 * cent so a cheap run does not read as `$0.00`.
 */
export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
