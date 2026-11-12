/**
 * ATO-915: when is a Skills Hub error "ClawHub could not be reached" rather
 * than something the window did wrong?
 *
 * The full smoke's two ClawHub search checks (main.ts, `skills hub: \`/\`
 * search …` and `… ClawHub's detail endpoint`) skip with the reason when the
 * service is down, and keep asserting the fallback to the GitHub taps. The old
 * test only knew 5xx / 429 / ENOTFOUND / ETIMEDOUT / fetch failed. On the
 * second Mac without VPN ClawHub never answers, the request hits the client's
 * own clock and the error reads
 * `clawhub: The operation was aborted due to timeout`, so both checks went red
 * on every such run (23 and 24.10).
 *
 * Only network-shaped texts count. A 404, an "ambiguous slug" or an empty
 * result is ClawHub answering, and those still fail the check.
 */
const UNREACHABLE = [
  /request failed \((?:5\d\d|429)\)/i,         // ClawHub answered, but with an outage
  /\bENOTFOUND\b|\bEAI_AGAIN\b/i,               // DNS
  /\bETIMEDOUT\b|\bECONNREFUSED\b|\bECONNRESET\b|\bENETUNREACH\b|\bEHOSTUNREACH\b/i,
  /fetch failed/i,                              // undici's catch-all for a dead socket
  /aborted due to timeout|\bTimeoutError\b/i,  // AbortSignal.timeout fired (no VPN on the MBP)
  /network error fetching/i,                    // clawhub-client.ts wraps every transport failure in this
];

export function isHubUnreachable(hubError: string | null | undefined): boolean {
  if (!hubError) return false;
  return UNREACHABLE.some((re) => re.test(hubError));
}
