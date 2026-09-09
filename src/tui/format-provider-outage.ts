import type { TuiState } from "./tui-state.js";

/** Longest reason fragment carried into the one-row meta bar. */
const REASON_MAX_LEN = 48;

/**
 * Transport messages rewritten for someone who is not reading a stack
 * trace. Presentation only — the runtime classifier
 * (`src/llm/reliability/network-error.ts`) keeps the raw wording,
 * because that is what the logs, the trace and the failure category are
 * matched on.
 *
 * The three mid-stream drops are the same set `MID_STREAM_DROP_MESSAGES`
 * recognises, and for the same argued reason: each can only come from a
 * socket that was already carrying a request when it died, so "dropped
 * mid-reply" is a claim about what happened rather than a guess.
 * `fetch failed` is deliberately *not* in that set — undici throws it
 * for a connection that never opened — so it gets the other sentence.
 */
const HUMANISED_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^terminated\b/i, "connection dropped mid-reply"],
  [/^socket hang up\b/i, "connection dropped mid-reply"],
  [/^other side closed\b/i, "connection dropped mid-reply"],
  [/^fetch failed\b/i, "no connection"],
];

/**
 * The composer's provider-outage readout.
 *
 * Three states, because they ask for different things from the operator:
 *
 * - **parked** — the backoff sleep. Nothing to do but wait (or press
 *   Esc), so the row carries how long it has waited and how long it will
 *   keep trying, counted live off `sinceTs` rather than off the last
 *   event, which stood still for whole minutes at a time.
 * - **retrying** — the parked step is back on the wire and may stream
 *   for minutes before anything else is emitted. The row says which
 *   attempt is running and how long it has been running: the one fact
 *   that separates a working retry from a hung one.
 * - **given up** — the wait ran out. Every message from here on will
 *   fail the same way until the link is back, which is exactly what nine
 *   identical one-second failures in a row failed to say.
 *
 * `now` is a parameter so the caller's render tick drives the counter
 * and the wording is testable without faking the clock.
 *
 * Kept short and reason-first: this shares a row with the route, the
 * context readout and the mode chip, and a wrapped meta bar would cost
 * the composer a line.
 */
export function formatProviderOutage(
  outage: NonNullable<TuiState["providerOutage"]>,
  now: number = Date.now(),
): string {
  if (outage.givenUp) {
    return `provider unreachable — ${describeReason(outage.reason)}`;
  }
  const inPhaseMs = Math.max(0, now - outage.sinceTs);
  if (outage.phase === "retrying") {
    return `retrying provider (attempt ${outage.attempt}) — ${seconds(inPhaseMs)}s`;
  }
  // Clamped: the loop never sleeps past the budget, so a counter that
  // ran through it would be promising a wait that is not coming.
  const waited = Math.min(outage.waitedMs + inPhaseMs, outage.maxWaitMs);
  return `waiting for provider ${seconds(waited)}s/${seconds(
    outage.maxWaitMs,
  )}s — ${describeReason(outage.reason)}`;
}

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

function describeReason(raw: string): string {
  const flat = raw.trim().replace(/\s+/g, " ");
  for (const [pattern, text] of HUMANISED_REASONS) {
    if (pattern.test(flat)) return text;
  }
  return shortenReason(flat);
}

function shortenReason(flat: string): string {
  if (flat.length <= REASON_MAX_LEN) return flat;
  return `${flat.slice(0, REASON_MAX_LEN - 1)}…`;
}
