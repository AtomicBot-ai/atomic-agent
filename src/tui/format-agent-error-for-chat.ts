import { formatLlamaUnreachableHint } from "../llm/llama-server-health.js";
import { looksLikeDroppedConnection } from "../llm/reliability/network-error.js";

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
 */
const DROPPED_CONNECTION_HINT = [
  "the connection to the model dropped before the reply finished",
  "  the steps that already finished are kept in this session — ask to continue from there; re-sending the whole task starts it over",
].join("\n");

/**
 * Compact, chat-safe agent failure text (strips HTML walls from bad URLs).
 */
export function formatAgentErrorForChat(
  category: string,
  message: string,
  local?: LocalProviderErrorContext,
): string {
  let body = message.trim().replace(/\s+/g, " ");
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
    // Matched on the raw message rather than `body`: `body` may have been
    // truncated or swapped for the HTML placeholder above, and the hint
    // must key off what the transport actually said. The formatter is
    // handed `(category, message)` — see the note on the predicate in
    // `llm/reliability/network-error.ts` for why the text is the signal.
    if (looksLikeDroppedConnection(message)) {
      return `${base}\n${DROPPED_CONNECTION_HINT}`;
    }
  }
  return base;
}
