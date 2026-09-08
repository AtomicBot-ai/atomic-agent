import type { TuiState } from "./tui-state.js";

/** Longest reason fragment carried into the one-row meta bar. */
const REASON_MAX_LEN = 48;

/**
 * The composer's provider-outage readout.
 *
 * Two states, because they ask for different things from the operator:
 * while the turn is parked there is nothing to do but wait (or press
 * Esc), and the useful facts are how long it has waited and how long it
 * will keep trying. Once the wait has run out, the useful fact is that
 * every message from here on will fail the same way until the link is
 * back — which is exactly what nine identical one-second failures in a
 * row failed to say.
 *
 * Kept short and reason-first: this shares a row with the route, the
 * context readout and the mode chip, and a wrapped meta bar would cost
 * the composer a line.
 */
export function formatProviderOutage(
  outage: NonNullable<TuiState["providerOutage"]>,
): string {
  const reason = shortenReason(outage.reason);
  if (outage.givenUp) {
    return `provider unreachable — ${reason}`;
  }
  const waited = Math.round(outage.waitedMs / 1000);
  const budget = Math.round(outage.maxWaitMs / 1000);
  return `waiting for provider ${waited}s/${budget}s — ${reason}`;
}

function shortenReason(raw: string): string {
  const flat = raw.trim().replace(/\s+/g, " ");
  if (flat.length <= REASON_MAX_LEN) return flat;
  return `${flat.slice(0, REASON_MAX_LEN - 1)}…`;
}
