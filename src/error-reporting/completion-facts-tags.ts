/**
 * Tags for the shape of the completion a `ModelError` was raised on, and
 * for the kind of server that produced it (ATO-2421).
 *
 * `reason=empty` alone is three stories with three fixes: a model that
 * thought and never answered, a server that closed the turn at once, and
 * a prompt the server cut to its context before the model saw it (a
 * local Ollama loads models at 4096 tokens unless told otherwise). These
 * tags make each a filter:
 *
 *  - `finish_reason`: the provider's word (or llama-server's `stop_type`
 *    when it sent no finish reason), from a fixed list; `none` when it
 *    sent neither, `other` for any word not on the list;
 *  - `reasoning_present`: `yes` / `no`;
 *  - `served_prompt_tokens` / `served_reply_tokens`: the server's own
 *    counts. Read beside `prompt_total_tokens`, a served prompt far
 *    below the built one is a prompt the server shortened;
 *  - `server_kind`: `ollama` / `llama_server` / `other`, from the failing
 *    link's configuration, so an Ollama server under a custom provider
 *    id is still told apart.
 *
 * Fixed words and counts only: never the reply, the reasoning, the
 * provider id the person typed, or the server's address.
 */

/** Raw facts, as `ModelError.completion` carries them. */
export interface LlmCompletionFacts {
  finishReason: string | null;
  stopType?: string;
  reasoningPresent: boolean;
  promptTokens: number;
  completionTokens: number;
}

/** The kind of server the failing link points at. */
export type ServerKind = "ollama" | "llama_server" | "other";

const FINISH_REASONS: ReadonlySet<string> = new Set([
  // OpenAI-compatible finish reasons.
  "stop",
  "length",
  "tool_calls",
  "function_call",
  "content_filter",
  "error",
  // Set by our own stream watcher when it cut a fabricated transcript.
  "fabricated_transcript",
  // llama-server `stop_type` values.
  "eos",
  "word",
  "limit",
]);

const SERVER_KINDS: ReadonlySet<string> = new Set(["ollama", "llama_server", "other"]);

function finishWord(facts: LlmCompletionFacts): string {
  const raw = facts.finishReason ?? facts.stopType ?? null;
  if (raw === null || raw.length === 0) return "none";
  const word = raw.toLowerCase();
  return FINISH_REASONS.has(word) ? word : "other";
}

/** `0` is "not reported", not a count. */
function servedCount(value: number): string {
  return Number.isFinite(value) && value > 0 ? String(Math.round(value)) : "unknown";
}

/** The tags for a model failure's completion facts and server kind. */
export function completionFactsTags(
  facts: LlmCompletionFacts | undefined,
  serverKind: string | undefined,
): Record<string, string> {
  const tags: Record<string, string> = {};
  if (facts !== undefined) {
    tags.finish_reason = finishWord(facts);
    tags.reasoning_present = facts.reasoningPresent ? "yes" : "no";
    tags.served_prompt_tokens = servedCount(facts.promptTokens);
    tags.served_reply_tokens = servedCount(facts.completionTokens);
  }
  if (serverKind !== undefined) {
    tags.server_kind = SERVER_KINDS.has(serverKind) ? serverKind : "other";
  }
  return tags;
}
