/**
 * One sentence per contract-probe verdict, in the voice the key check
 * and the cloud error path already use: who answered, what happened,
 * what to do about it.
 *
 * Three rules the wording has to keep:
 *
 *  - Never say "incompatible" for something the probe did not establish.
 *    `inconclusive_no_tool_call` is the model declining to call a
 *    pointless function, which is legal behaviour, not a broken route.
 *  - Never say "compatible" for anything but a completed tool call.
 *  - Always name the next move. `HTTP 400` on a setup screen reads as a
 *    product failure; "answers fine until `tools` is in the request"
 *    reads as a route to change.
 */

import type { ProviderContractProbeResult } from "../../llm/provider/verify/index.js";

export function describeContractProbeOutcome(
  result: ProviderContractProbeResult,
  label: string,
): string {
  const who = `"${label}"`;
  const on = ` on ${result.probedModel}`;
  switch (result.status) {
    case "tools_supported":
      return `${who} streamed a native tool call${on} — this route can run a turn.`;
    case "inconclusive_no_tool_call":
      return `${who} answered in text instead of calling a tool${on}. Inconclusive: it would not take a forced tool choice, so whether it can emit tool calls is still unknown.`;
    case "forced_tool_choice_ignored":
      return `${who} accepted a forced tool choice${on} and answered in text anyway. Turns that must call a tool may loop or stall on this route.`;
    case "forced_tool_choice_rejected":
      return `${who} refuses a forced tool choice${on} but does emit tool calls without one${statusSuffix(result)}. Usable, with less control over when tools fire.`;
    case "tools_payload_rejected":
      return `${who} answers this model until "tools" is in the request, then refuses it${statusSuffix(result)}. Pick another model or route — Atomic sends tools on every turn.`;
    case "model_unavailable":
      return `${who} does not recognise ${result.probedModel}${statusSuffix(result)}. Pick a model this route actually serves.`;
    case "endpoint_auth_failed":
      return `${who} rejected the key when asked for a streamed tool call${statusSuffix(result)}. Tool support is still untested.`;
    case "quota_or_routing_failed":
      return `${who} could not run the check — out of quota, or no backend to route to${statusSuffix(result)}. Tool support is still untested.`;
    case "stream_early_eof":
      return `${who} closed the stream${on} before finishing the answer. Turns will end mid-tool-call on this route.`;
    case "malformed_tool_call":
      return `${who} streamed tool-call deltas${on} that never formed a callable tool. Atomic would fail the turn with a tool it cannot look up.`;
    case "unreachable":
      return `Could not reach ${who} for the contract check. Tool support is untested — check the connection or the base URL.`;
    case "timeout":
      return `${who} did not finish the contract check in time${on}. Tool support is untested.`;
    case "cancelled":
      return `Contract check cancelled. Tool support is untested.`;
    default:
      return `${who} failed the contract check${statusSuffix(result)}. Tool support is untested — this looks like the route, not your setup.`;
  }
}

function statusSuffix(result: ProviderContractProbeResult): string {
  return result.httpStatus === null ? "" : ` (${result.httpStatus})`;
}
