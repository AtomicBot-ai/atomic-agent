/**
 * llama.cpp's DRY ("don't repeat yourself") sampler, behind
 * `localModels.drySampler` (default off, ATO-332).
 *
 * DRY penalises a token that would extend a sequence already present in
 * the context, growing the penalty with the length of the repeat. That
 * is the shape of the verbatim loops small local models fall into (the
 * same tool call or sentence over and over), which `repeat_penalty`
 * alone, a per-token penalty, does not stop.
 *
 * Only `LlamaServerClient` sends these fields, so they reach llama.cpp
 * engines only: Atomic Core's llama-server, the managed llama-server and
 * an External llama-server. Ollama and cloud providers use other clients.
 */

/** Strength of the penalty; `0` disables DRY in llama.cpp. */
export const DRY_MULTIPLIER = 0.8;
/** Growth of the penalty per token of repeat beyond the allowed length. */
export const DRY_BASE = 1.75;
/** Repeats up to this many tokens are free (short n-grams are normal text). */
export const DRY_ALLOWED_LENGTH = 2;

/**
 * The DRY fields for one `/completion` payload. `nPredict` is the
 * request's resolved answer limit (`n_predict`) and becomes
 * `dry_penalty_last_n`, so the window looking back for repeats is as
 * long as the reply may be. An unbounded reply (`-1`) maps to `-1`,
 * which llama.cpp reads as the whole context.
 */
export function drySamplerFields(nPredict: number): Record<string, number> {
  return {
    dry_multiplier: DRY_MULTIPLIER,
    dry_base: DRY_BASE,
    dry_allowed_length: DRY_ALLOWED_LENGTH,
    dry_penalty_last_n: nPredict,
  };
}
