/**
 * llama.cpp's DRY ("don't repeat yourself") sampler, behind
 * `localModels.drySampler` (default off, ATO-332).
 *
 * DRY penalises a token that would extend a sequence already present in
 * the last `DRY_PENALTY_LAST_N` tokens, growing the penalty with the
 * length of the repeat. That targets the verbatim prose loops small local
 * models fall into (the same sentence over and over), which
 * `repeat_penalty` alone, a per-token penalty, does not stop. llama.cpp's
 * default sequence breakers (newline, `:`, `"`, `*`) reset the match, so
 * a repeated JSON tool call is only lightly penalised.
 *
 * Only `LlamaServerClient` sends these fields, on every `/completion`
 * request, so they reach llama.cpp engines only: Atomic Core's
 * llama-server, the managed llama-server and an External llama-server.
 * Ollama and cloud providers use other clients; the vision describe call
 * (`/v1/chat/completions`) does not carry them either.
 */

/** Strength of the penalty; `0` disables DRY in llama.cpp. */
export const DRY_MULTIPLIER = 0.8;
/** Growth of the penalty per token of repeat beyond the allowed length. */
export const DRY_BASE = 1.75;
/** Repeats up to this many tokens are free (short n-grams are normal text). */
export const DRY_ALLOWED_LENGTH = 2;
/**
 * How many tokens back DRY looks for repeats. llama-server feeds the
 * prompt into the sampler too, so this window covers the tail of the
 * prompt plus the reply. Fixed, like our `repeat_last_n`, rather than
 * the reply's limit: a window of thousands of tokens would penalise
 * exact copying from context (a path, an `os.fs.edit` old string), and
 * an unbounded limit (`-1`) is rejected by llama-server with HTTP 400.
 * Always positive.
 */
export const DRY_PENALTY_LAST_N = 256;

/** The DRY fields for one `/completion` payload. */
export function drySamplerFields(): Record<string, number> {
  return {
    dry_multiplier: DRY_MULTIPLIER,
    dry_base: DRY_BASE,
    dry_allowed_length: DRY_ALLOWED_LENGTH,
    dry_penalty_last_n: DRY_PENALTY_LAST_N,
  };
}
