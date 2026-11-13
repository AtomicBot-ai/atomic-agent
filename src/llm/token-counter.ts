/**
 * The model's own token count for a text, for the few decisions where the
 * shared heuristic's margin (`estimateTokens` over-counts by roughly
 * 10-15% on English, under-counts dense scripts) moves the outcome — today
 * the automatic compaction trigger (ATO-656).
 *
 * A counter is consulted only at such a decision point, never per render:
 * the heuristic stays the default everywhere and the fallback whenever
 * this answers `null`.
 *
 * Implementations:
 *  - local llama-server: `/tokenize` ({@link createLlamaTokenizeCounter});
 *  - cloud: {@link byteEstimateCounter}, `ceil(utf8 bytes / 4)`. No
 *    tokenizer dependency is bundled (it would weigh on the SEA binary);
 *    after the call the provider's own usage counts are what the session
 *    records.
 */
export interface TokenCounter {
  /** Tokens `text` takes for the serving model, or `null` when it cannot be had. Never throws. */
  count(text: string, signal?: AbortSignal): Promise<number | null>;
}

/** UTF-8 bytes per token assumed for a cloud route (ATO-656). */
export const CLOUD_BYTES_PER_TOKEN = 4;

/** `ceil(utf8 bytes / 4)`: the cloud estimate, with no tokenizer dependency (ATO-656). */
export function estimateTokensFromBytes(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / CLOUD_BYTES_PER_TOKEN);
}

/** A counter for routes without a tokenize endpoint (cloud): the byte estimate. Never throws. */
export const byteEstimateCounter: TokenCounter = {
  async count(text: string): Promise<number | null> {
    return estimateTokensFromBytes(text);
  },
};
