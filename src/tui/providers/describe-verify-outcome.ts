/**
 * One sentence per verification outcome, in the same voice the cloud
 * error path already uses (`humanizeOpenAiHttpError`): who answered,
 * what happened, what to do about it. A raw `http 402` on the key screen
 * reads as a product failure when it is in fact an empty account.
 */

import type { ProviderVerifyResult } from "../../llm/provider/verify/index.js";

export function describeProviderVerifyOutcome(
  result: ProviderVerifyResult,
  label: string,
): string {
  const who = `"${label}"`;
  const model = result.probedModel ? ` (tested with ${result.probedModel})` : "";
  switch (result.status) {
    case "ok":
      return `${who} accepted the key${model}.`;
    case "invalid_key":
      return `${who} rejected this key${statusSuffix(result)}. Check it belongs to ${label}, then paste it again.`;
    case "no_balance":
      return `${who} accepted the key but has no usable balance${statusSuffix(result)}. Top up the account or enable billing, then try again.`;
    case "rate_limited":
      return `${who} is rate-limiting this key right now — the key itself works. Saved without a completed test.`;
    case "model_unavailable":
      return `${who} has no model this check could run${model}. Saved without a live test.`;
    case "timeout":
      return `${who} did not answer the key check in time. Saved unverified — the key was not tested.`;
    case "unreachable":
      return `Could not reach ${who} to test the key. Saved unverified — check the connection or the base URL.`;
    case "cancelled":
      return `Key check cancelled. Nothing was saved.`;
    default:
      return `${who} failed the key check${statusSuffix(result)}. Saved unverified — this looks like the provider, not your key.`;
  }
}

function statusSuffix(result: ProviderVerifyResult): string {
  return result.httpStatus === null ? "" : ` (${result.httpStatus})`;
}
