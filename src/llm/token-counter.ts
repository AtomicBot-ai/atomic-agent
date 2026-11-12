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
 *  - cloud: none yet. An OpenAI-like route could use one `gpt-tokenizer`
 *    encoding through its import subpath; whether that dependency and its
 *    weight in the SEA binary are worth it is an open decision, so no
 *    cloud route has a counter and the heuristic decides there.
 */
export interface TokenCounter {
  /** Tokens `text` takes for the serving model, or `null` when it cannot be had. Never throws. */
  count(text: string, signal?: AbortSignal): Promise<number | null>;
}
