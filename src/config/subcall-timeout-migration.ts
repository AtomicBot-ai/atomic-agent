/**
 * Memory sub-call timeouts sized for hosted models (config v65).
 *
 * Reflection, the link-generator and the vote-runner run fire-and-forget
 * after a turn. Their pre-v65 defaults — 10 s for reflection (which the
 * vote-runner reuses) and 8 s for the link-generator — were tuned
 * against a local llama-server. Hosted reasoning models answer the same
 * requests in roughly 15–40 s, so most sub-calls ran into the cap and
 * wrote nothing.
 *
 * The query rewriter had 3 s. It sits on the hot path, so its cap stays
 * well below the background ones (10 s): hosted models rewrite in a
 * median 4–24 s, and the rewriter now runs once per turn, so a timeout
 * costs a turn one wait rather than one per step.
 *
 * Every `config.json` already carries these fields, written by the
 * schema rather than by the operator, so a pre-v65 file whose value
 * equals the old default is read as "never chosen" and takes the new
 * default. Any other value is a deliberate pin and is kept. Same shape
 * as the v63 `localModels.managed.parallel` migration.
 */

/** First config version whose sub-call timeout defaults are the hosted-model ones. */
export const HOSTED_SUBCALL_TIMEOUTS_VERSION = 65;

/** What the schema wrote before v65 — never an operator's choice. */
export const PRE_V65_SUBCALL_TIMEOUT_DEFAULTS = {
  reflectionTimeoutMs: 10_000,
  linkGeneratorTimeoutMs: 8_000,
  rewriterTimeoutMs: 3_000,
} as const;

/**
 * `value` is the already-parsed field (the current default when the file
 * had none). A pre-v65 value equal to `previousDefault` becomes
 * `currentDefault`; everything else is returned unchanged.
 */
export function resolveSubcallTimeoutMs(
  inputVersion: number,
  value: number,
  previousDefault: number,
  currentDefault: number,
): number {
  if (
    inputVersion < HOSTED_SUBCALL_TIMEOUTS_VERSION &&
    value === previousDefault
  ) {
    return currentDefault;
  }
  return value;
}
