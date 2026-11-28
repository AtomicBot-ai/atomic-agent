import type { ScrubbedErrorEvent } from "./error-scrubber.js";
import { requestHostIsLocal, requestUrlOf } from "./failure-owner.js";

/**
 * "The provider refused the person's own account or setup" (ATO-1673).
 *
 * A key the provider does not take, an account out of credit, a rate
 * limit, a model id the provider does not serve, a cloud model that
 * takes no tools: the person is told in chat what happened and what to
 * do, and nothing in the agent misbehaved. Tagged `failure_owner=person`
 * (ATO-2419), they were still about 600 Sentry events in two weeks and
 * buried the refusals that are ours. Claude Code and Codex show account,
 * billing and rate-limit errors to the user and do not report them as
 * crashes; same pattern here as a signed-out subscription CLI
 * (ATO-2417) and Atomic Chat not running (ATO-1278).
 *
 * Read off the scrubbed event, so the filter and the tag can never
 * disagree. Still reported:
 *  - a 413, and a refusal whose reason is `request_too_large` (except on
 *    a 429, a plan's per-minute allowance): the prompt we built may be
 *    too big for any plan (a bare 413 stays reported, ATO-1283);
 *  - a refusal from a server on this machine, unless it is one the
 *    person runs themselves (Ollama, LM Studio, Atomic Chat, by their
 *    default port): the managed engine is ours. A local 401/403 is
 *    already `unknown`, never `person`.
 */
export function isPersonRefusal(err: unknown, event: ScrubbedErrorEvent): boolean {
  if (event.source !== "llm_failure" || event.failureOwner !== "person") return false;
  if (event.httpStatus === 413) return false;
  if (event.upstreamReason === "request_too_large" && event.httpStatus !== 429) return false;
  // The same host rule `failure_owner` was read with.
  if (requestHostIsLocal(err)) return isPersonRunServer(requestUrlOf(err));
  return true;
}

/**
 * Default ports of the local servers a person starts and loads models in
 * themselves: Ollama, LM Studio, Atomic Chat's Local API Server. Read by
 * default port, like `localServerProgram` in `openai-http.ts` (which
 * names only 1337 and 11434); kept here so this module takes no import
 * from the LLM layer.
 */
const PERSON_RUN_PORTS: ReadonlySet<string> = new Set(["11434", "1234", "1337"]);

function isPersonRunServer(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    return PERSON_RUN_PORTS.has(new URL(url).port);
  } catch {
    return false;
  }
}
