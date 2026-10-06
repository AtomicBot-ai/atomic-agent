/**
 * Rotating status phrases shown while the agent is running. Mirrors
 * openclaw's `tui-waiting.ts` — picking a single phrase per waiting
 * session avoids flicker/context-switch on the user's side. The phrases
 * are intentionally neutral and information-free; load is derived from
 * the spinner + elapsed timer, not the phrase.
 */

export const DEFAULT_WAITING_PHRASES: readonly string[] = [
  "consulting repo index",
  "compiling thoughts",
  "drafting plan",
  "probing tool registry",
  "summoning tokens",
  "threading the needle",
  "chasing context",
  "weighing options",
  "assembling patch",
  "validating grammar",
];

/**
 * Pick a phrase deterministically from a seed. The orchestrator passes
 * the current run's start timestamp so a single run gets a stable
 * phrase, preventing per-frame churn.
 */
export function pickWaitingPhrase(
  seed: number,
  phrases: readonly string[] = DEFAULT_WAITING_PHRASES,
): string {
  if (phrases.length === 0) return "working";
  const idx = Math.abs(Math.floor(seed)) % phrases.length;
  return phrases[idx] ?? phrases[0] ?? "working";
}
