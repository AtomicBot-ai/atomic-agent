/**
 * Does a provider's 400/422 body say that one of the sampling settings
 * the agent sent is wrong (ATO-1218)?
 *
 * "invalid temperature: only 1 is allowed for this model" (Moonshot, Kimi
 * K3.1), "top_p must be between 0 and 1", "Unsupported value: 'temperature'
 * does not support 0.2 with this model" (OpenAI reasoning models),
 * "temperature is deprecated for this model" (newer Claude models). Such a
 * refusal is about the request we built, not about the provider being
 * down: the fallback chain must stop on it with the provider's own words
 * instead of silently moving the turn to another link (often the local
 * model the person did not pick).
 *
 * Deliberately narrow, like `allowed-temperature.ts`:
 *  - only the sampling / generation settings a model card or `extraBody`
 *    sets. `tools`, `max_tokens` / `max_completion_tokens` and other
 *    body-shape refusals keep falling over: another link may well accept
 *    them (see `isRequestSizeRejection` for the size cases).
 *  - the setting's name must be said close to the refusal word, so a
 *    validator that echoes the whole request back does not turn a refusal
 *    of some other field into this one.
 */

const SAMPLING_PARAMETER_RE =
  /\b(temperature|top_p|top_k|min_p|typical_p|presence_penalty|frequency_penalty|repetition_penalty|repeat_penalty|seed|logit_bias|top_logprobs|reasoning_effort)\b/gi;

const REFUSAL_RE =
  /\b(?:invalid|unsupported|not supported|not allowed|not permitted|only\s+[0-9.]+\s+is\s+allowed|must be|should be|out of range|deprecated|no longer supported|unknown|unrecognized|unrecognised|expected)\b/i;

/** How far from the setting's name the refusal word may be. */
const NEAR_CHARS = 100;

/**
 * The name of the sampling setting the text refuses, lower-case, or null
 * when the text refuses none of them.
 */
export function invalidSamplingParameter(text: string): string | null {
  for (const match of text.matchAll(SAMPLING_PARAMETER_RE)) {
    const at = match.index ?? 0;
    const from = Math.max(0, at - NEAR_CHARS);
    const to = at + match[0].length + NEAR_CHARS;
    if (REFUSAL_RE.test(text.slice(from, to))) return match[1]!.toLowerCase();
  }
  return null;
}
