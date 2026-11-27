import type { FailureVerdict } from "../../llm/reliability/index.js";

const MAX_CHARS = 480;

/**
 * Causes where a cloud provider answered and said no: the first line says
 * which no in plain words (the shared catalog phrase), and the agent's
 * sentence, which may carry the status and the provider's own words,
 * moves under `Details:` (ATO-1673). Before, every one of them opened
 * with "couldn't get a reply from the provider", which is false: the
 * provider replied, with a refusal.
 */
const PROVIDER_REFUSALS: ReadonlySet<string> = new Set([
  "out_of_credit",
  "rate_limited",
  "auth_rejected",
  "model_not_found",
  "request_rejected",
]);

/**
 * The account's state, never a defect of the agent: no `/report` line
 * under it. Claude Code and Codex show a billing or rate-limit refusal
 * as a plain notice, not as something to file. A refused key, a model
 * id and a refused request keep the line: on some routes they can be
 * ours.
 */
const ACCOUNT_STATES: ReadonlySet<string> = new Set(["out_of_credit", "rate_limited"]);

/**
 * The chat text of a turn a cloud provider refused, or null when the
 * failure is anything else or the route is a local server (that keeps
 * its own hints in `formatAgentErrorForChat`).
 */
export function formatProviderRefusalForChat(
  failure: FailureVerdict | undefined,
  message: string,
  activeProviderIsLocal: boolean,
  /** `describeFailedAttempts(error)`, appended after the capped body. */
  fallbackNote = "",
): string | null {
  if (activeProviderIsLocal || failure === undefined) return null;
  if (!PROVIDER_REFUSALS.has(failure.cause)) return null;
  const collapsed = message.trim().replace(/\s+/g, " ");
  const body = collapsed.length > MAX_CHARS ? `${collapsed.slice(0, MAX_CHARS)}…` : collapsed;
  const details = `${body}${fallbackNote}`.trim();
  const head = `Turn failed: ${failure.phrase}`;
  return details.length > 0 ? `${head}\nDetails: ${details}` : head;
}

/** True when the failure is the account's state, with nothing to report. */
export function isAccountStateFailure(failure: FailureVerdict | undefined): boolean {
  return failure !== undefined && ACCOUNT_STATES.has(failure.cause);
}
