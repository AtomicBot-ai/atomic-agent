import { formatLlamaUnreachableHint } from "../llm/llama-server-health.js";
import { looksLikeMidStreamDrop } from "../llm/reliability/index.js";

const MAX_CHARS = 480;

/**
 * Where the failed turn was pointed, so a transport failure can say what
 * to actually do about it. The CLI has printed
 * `formatLlamaUnreachableHint` for years; the TUI dropped the same
 * failure as a bare `fetch failed` — this closes that gap. Gated on the
 * active provider being local because for a cloud provider the llama
 * hint would be advice about the wrong server.
 */
export interface LocalProviderErrorContext {
  activeProviderIsLocal: boolean;
  llamaUrl: string;
}

/**
 * What a dropped connection actually means, for an operator who
 * otherwise reads `Turn failed [transport]: terminated` and concludes
 * the whole task is gone.
 *
 * Keyed off `looksLikeMidStreamDrop`, not the classifier's broader
 * `looksLikeDroppedConnection`: line 1 asserts a reply was in flight,
 * which is false for undici's catch-all `fetch failed` (a connection
 * that never opened reads exactly the same). See the two lists in
 * `llm/reliability/network-error.ts`.
 *
 * Both lines are things the code guarantees, not hopes. The turn's
 * `tool_call` / `tool_result` rows are recorded into `SessionState.turns`
 * by `step-executor.ts` as each step completes; the agent loop's `failed`
 * branch RETURNS instead of throwing (agent-loop.ts, "Symmetric with the
 * cancelled path above"), so `executeTurn` in `runtime/bootstrap.ts`
 * reaches its `sessionStore.save(finished)`, and `chat-orchestrator.ts`
 * keeps that same session as the active one. The next message in the
 * session therefore renders those `tool_result` turns back into the
 * prompt (`prompt/build-prompt-world-conversation.ts`).
 *
 * Deliberately NOT promised: automatic resumption. Nothing retries or
 * replays the dead stream — `llm/fallback/prime-stream.ts` pins the
 * invariant that a stream which already emitted output is never
 * restarted — so the operator has to ask for the continuation.
 *
 * Known imprecision, unchanged in kind from `main`: the predicate is
 * unanchored, so a gateway that quotes its own upstream inside a JSON
 * body (`{"error":{"message":"upstream: socket hang up"}}`) is a reply
 * that DID arrive and still draws line 1. Line 2 stays true either way.
 */
const DROPPED_CONNECTION_HINT = [
  "the connection to the model dropped before the reply finished",
  "  the steps that already finished are kept in this session — ask to continue from there; re-sending the whole task starts it over",
].join("\n");

/**
 * Compact, chat-safe agent failure text (strips HTML walls from bad URLs).
 *
 * The HTML-wall block below is `main`'s heuristic, character for
 * character, on purpose. It is known to be wrong on several shapes — it
 * walls any payload over 800 characters whether or not there is markup
 * in it, and scrapes `/\b(\d{3})\b/` out of the result as an "upstream
 * HTTP status" that may well be a line number — but that is a
 * pre-existing defect with its own blast radius, unrelated to the
 * dropped-stream message this change exists for. It is written up in the
 * pull request so it can be fixed on its own terms; do not repair it
 * here.
 */
export function formatAgentErrorForChat(
  category: string,
  message: string,
  local?: LocalProviderErrorContext,
): string {
  // One normalisation, used for both the body and the drop predicate, so
  // the two can never disagree about what the transport said. Before,
  // the predicate read the raw `message` while the body read this
  // collapsed form, which meant `"socket\nhang\nup"` printed the drop
  // phrase and withheld its explanation. Collapsing cannot widen the
  // anchored pattern (`/^terminated$/i` already sees a trimmed string)
  // and can only help the unanchored ones find a phrase a line break
  // had split.
  const collapsed = message.trim().replace(/\s+/g, " ");
  let body = collapsed;
  // Set when the wall below throws the transport's own words away and
  // substitutes a diagnosis of its own.
  let diagnosedAsWall = false;
  if (
    body.includes("<!DOCTYPE") ||
    body.includes("<html") ||
    body.length > 800
  ) {
    const statusMatch = /\b(\d{3})\b/.exec(body);
    const status = statusMatch?.[1];
    body =
      status != null
        ? `upstream HTTP ${status} (wrong API URL or provider config)`
        : "upstream returned HTML instead of JSON (check API URL and provider)";
    diagnosedAsWall = true;
  }
  if (body.length > MAX_CHARS) {
    body = `${body.slice(0, MAX_CHARS)}…`;
  }
  const base = `Turn failed [${category}]: ${body}`;
  if (category === "transport") {
    // The local arm wins the overlap on purpose, and stays byte-identical
    // to what it has always emitted. A socket that dies on a local route
    // is nearly always llama-server itself going down or restarting, and
    // "start it with: atomic-agent models start" is a FIX; the drop hint
    // below is only an explanation. Stacking both would bury the fix
    // under five lines. The `terminated` case that prompted this — a
    // cloud provider dropping mid-stream — never reaches the local arm.
    if (local?.activeProviderIsLocal) {
      return `${base}\n${formatLlamaUnreachableHint(local.llamaUrl)}`;
    }
    // Matched on `collapsed`, never on `body`: `body` has been capped at
    // MAX_CHARS, so a drop phrase that sits past that cap survives in
    // one and not the other, and the hint must key off what the
    // transport actually said. Pinned by a test that fails if this is
    // switched to `body`.
    //
    // Except when the wall above fired. This guard makes no claim about
    // the wall being right — it is about not printing two diagnoses of
    // one failure. Once the wall has spoken, `body` is no longer a
    // truncation of the transport's words but a rival account of the
    // same failure ("upstream returned HTML instead of JSON", "upstream
    // HTTP 502"), and appending "the connection dropped before the reply
    // finished" underneath it tells the operator two incompatible
    // stories in three lines. Exactly one of them can be true, and this
    // function has no way to tell which, so it adds nothing to what the
    // wall already decided. The cost is real and accepted: on a payload
    // the wall walls by mistake, this explanation is lost along with the
    // transport's own words — see the pre-existing-defect note in the
    // pull request.
    if (!diagnosedAsWall && looksLikeMidStreamDrop(collapsed)) {
      return `${base}\n${DROPPED_CONNECTION_HINT}`;
    }
  }
  return base;
}

/**
 * The line under every failed turn that says where a bug report goes.
 * Appended by the reducer at the one site that renders a turn failure,
 * so the wording lives next to the message it follows and a test can
 * pin the two together.
 */
export const REPORT_HINT =
  "  /report files this on GitHub with your logs — you choose how much is shared";

export function withReportHint(text: string): string {
  return `${text}\n${REPORT_HINT}`;
}
