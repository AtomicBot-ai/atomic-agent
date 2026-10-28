import { providerServiceName } from "../provider/provider-service-name.js";
import type { FailureCauseId } from "../reliability/failure-catalog.js";

/**
 * The one sentence a turn shows when the chain moves off the provider the
 * person picked to their fallback link (ATO-483): what happened to the
 * picked one, in plain words, and which link the turn moved to. "Switched
 * to", not "answered with": the chain announces the move before the
 * fallback has answered, and that link can fail too. "OpenRouter is
 * rate-limited, switched to Gemini (gemini-2.5-flash)."
 *
 * `failure` is the failure-catalog cause of the error that moved the
 * turn (`classifyFailureCause`); `toModel` the fallback entry's model,
 * when the host knows it. No status codes and no raw provider text: the
 * notice's `reason` still carries those for Details.
 */
export function falloverSentence(
  from: string,
  to: string,
  failure: FailureCauseId | undefined,
  toModel?: string,
): string {
  const who = providerServiceName(from);
  const switchedTo = toModel
    ? `${providerServiceName(to)} (${toModel})`
    : providerServiceName(to);
  return `${who} ${whatHappened(failure)}, switched to ${switchedTo}.`;
}

function whatHappened(failure: FailureCauseId | undefined): string {
  switch (failure) {
    case "rate_limited":
      return "is rate-limited";
    case "out_of_credit":
      return "is out of credit";
    case "auth_rejected":
      return "did not accept the API key";
    case "model_not_found":
      return "doesn't have this model";
    case "provider_setup":
      return "isn't installed or signed in";
    case "provider_trouble":
    case "provider_timeout":
    case "provider_unreachable":
    case "provider_error_mid_reply":
    case "connection_refused":
    case "connection_dropped":
    case "offline":
      return "isn't answering right now";
    default:
      return "failed";
  }
}
