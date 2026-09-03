/**
 * Turning one probe request into a verdict about the *route*.
 *
 * Two classifiers live here, and the split matters:
 *
 *  - `classifyContractProbeHttpFailure` reads a refusal. It answers
 *    only the questions a single status code and body can settle —
 *    credential, quota, model — and delegates that reading to
 *    `classifyVerifyResponse`, so the contract probe and the key check
 *    can never disagree about what a 402 or a Gemini 400 means.
 *  - `classifyProbeStream` reads a stream that was accepted, and
 *    settles whether a dispatchable native tool call actually arrived.
 *
 * Nothing here guesses "tools are unsupported" from error wording.
 * Provider phrasing for that is not stable enough to hang a verdict on,
 * and it does not need to be: the runner establishes it by experiment —
 * refuse with tools, answer without them — which is both stronger
 * evidence and the same evidence a human would gather by hand.
 */

import { classifyVerifyResponse } from "./classify-verify-response.js";
import {
  CONTRACT_PROBE_TOOL_NAME,
  type ProbeToolChoiceMode,
  type ProviderContractStatus,
} from "./contract-probe-types.js";
import type { ProbeStreamObservation } from "./accumulate-probe-stream.js";

/**
 * Classify a non-2xx answer to a probe request.
 *
 * Only the terminal classes are named here (see
 * `contractProbeFailureIsTerminal`). Anything else comes back as
 * `provider_error`, which the runner reads as "not settled yet" and
 * follows up on with the next rung of the ladder.
 */
export function classifyContractProbeHttpFailure(
  httpStatus: number,
  body: string,
): ProviderContractStatus {
  const verdict = classifyVerifyResponse(httpStatus, body);
  if (verdict.kind === "retry_next_model") return "model_unavailable";
  // The key check answers this hint by resending with the other field.
  // The probe must not: it sends the same `max_tokens` a turn sends
  // (see `run-contract-probe`), and `buildOpenAiChatBody` has no
  // `max_completion_tokens` fallback to switch to. Retrying would prove
  // a route works in a shape Atomic never uses and report a pass for a
  // route whose every turn 400s. So the refusal is the verdict.
  if (verdict.kind === "retry_token_field") return "token_cap_rejected";
  switch (verdict.status) {
    case "invalid_key":
      return "endpoint_auth_failed";
    case "no_balance":
    case "rate_limited":
      // One bucket on purpose: from a setup screen, "you are out of
      // credit" and "this gateway is throttling you" lead to the same
      // action — sort out the account, then probe again.
      return "quota_or_routing_failed";
    case "model_unavailable":
      return "model_unavailable";
    default:
      return "provider_error";
  }
}

/**
 * `true` when the refusal already explains itself and no further
 * request can teach us anything about tool support. Retrying a dead
 * key without `tools` would only spend another request to be told the
 * same thing.
 */
export function contractProbeFailureIsTerminal(
  status: ProviderContractStatus,
): boolean {
  return (
    status === "endpoint_auth_failed" ||
    status === "quota_or_routing_failed" ||
    status === "model_unavailable" ||
    // Every rung carries the same token cap, so the next one would be
    // refused for the same reason — and it is a real finding already.
    status === "token_cap_rejected"
  );
}

/**
 * Read an accepted stream.
 *
 * Order is deliberate. A stream that never announced its own end is
 * judged first and unconditionally: a tool call assembled out of a
 * truncated body may be missing argument fragments that were still in
 * flight, so trusting it is exactly the mistake
 * `applyToolCallTerminationSafety` exists to prevent on the real path.
 */
export function classifyProbeStream(
  observation: ProbeStreamObservation,
  mode: ProbeToolChoiceMode,
): ProviderContractStatus {
  if (!observation.terminalObserved) return "stream_early_eof";

  // The probe's own `max_tokens` ran out. A verbose or thinking model
  // can spend it honestly before it gets to a tool call, or in the
  // middle of one, so everything below this line would be blaming the
  // route for a limit we set. The one thing still worth reading is a
  // call that arrived *complete* despite the cut — that is proof, and
  // it is checked below by the same rules as any other.
  const truncatedByOurCap = observation.finishReason === "length";

  if (observation.sawToolCallDelta) {
    const call =
      observation.toolCalls.find((c) => c.name === CONTRACT_PROBE_TOOL_NAME) ??
      observation.toolCalls[0];
    // Deltas arrived and still produced nothing callable. On the real
    // path this is the failure that surfaces as `tool not registered in
    // this agent`, several minutes into a turn.
    const dispatchable =
      call !== undefined &&
      call.name.length > 0 &&
      // Only one function was offered, so any other name is the route
      // inventing one — the call could never be dispatched.
      call.name === CONTRACT_PROBE_TOOL_NAME &&
      argumentsAreDispatchable(call.arguments);
    if (dispatchable) return "tools_supported";
    return truncatedByOurCap ? "inconclusive_no_tool_call" : "malformed_tool_call";
  }

  if (truncatedByOurCap) return "inconclusive_no_tool_call";

  // No tool call at all. What that means depends entirely on what we
  // asked for, and conflating the two cases is the specific mistake
  // this probe is built to avoid.
  return mode === "required_named"
    ? "forced_tool_choice_ignored"
    : "inconclusive_no_tool_call";
}

/**
 * Arguments Atomic could actually hand to a tool. Empty is fine — the
 * probe's schema requires no field, and a model answering a forced call
 * with nothing to say legitimately sends `""` or `{}`. Anything else
 * has to parse as a JSON object; a truncated `{"ok":` is the shape a
 * route with incomplete deltas produces.
 */
function argumentsAreDispatchable(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return true;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
