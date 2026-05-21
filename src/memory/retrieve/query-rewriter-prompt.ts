/**
 * v2.5 query rewriter (Phase A) — prompt builder.
 *
 * The prompt is intentionally tiny (~200 tokens of stable prefix + up to
 * ~300 tokens of variable tail) so the rewriter call stays cheap
 * (~30-50ms cold on `slotId = -1`).
 *
 * Two-part structure mirrors the reflection runner:
 *  - {@link QUERY_REWRITER_STABLE_PREFIX} — byte-stable module-level
 *    constant. The slot that ends up running the rewriter (always
 *    `slotId = -1`, i.e. no cache reuse) does not benefit from
 *    cache hits on this string, but keeping the prefix stable means
 *    the prompt remains diffable across sessions for tracing.
 *  - variable tail — `### history` block (`USER:` / `ASSISTANT:`
 *    lines) followed by `### current` block (the user's just-sent
 *    message). The rewriter is told to emit the rewritten query
 *    inside `<rewritten_query>...</rewritten_query>` tags — that
 *    envelope is what the GBNF grammar accepts and what the parser
 *    extracts.
 */

/** Hard cap on a single transcript line (user or assistant) in the tail. */
export const REWRITER_LINE_CHAR_CAP = 400;

/** Hard cap on the rendered `### current` user message. */
export const REWRITER_CURRENT_CHAR_CAP = 500;

export interface RewriterHistoryTurn {
  /** `"user"` or `"assistant"`. */
  role: "user" | "assistant";
  /** Plain text — clamped by the builder. */
  text: string;
}

export interface RewriterPromptInput {
  /** Last N user/assistant exchanges in chronological order. */
  history: readonly RewriterHistoryTurn[];
  /** The current user message that needs rewriting. */
  currentMessage: string;
}

/**
 * Stable preamble. Touching this string invalidates whatever KV cache
 * happens to hold the rewriter prefix — but since the runner pins
 * `slotId = -1` the cache is never reused, so an edit here is a
 * one-off cost on the next call without any global ripple.
 */
export const QUERY_REWRITER_STABLE_PREFIX = `You rewrite a user's follow-up message into a self-contained search query.

The recall system uses keyword matching (BM25) and embedding similarity over a personal memory store. Short referential follow-ups ("a что там было?", "what about it?", "and the other one?") match almost nothing on their own, so we resolve the references against the recent conversation BEFORE running recall.

Rules:
- Inspect the recent history block and the current user message.
- Identify entities, topics, and intents the user is implicitly referring to (people, projects, decisions, code paths, places, time windows).
- Produce ONE concise query that contains those entities verbatim plus the user's intent. Keep it under 400 characters. Prefer the user's original language.
- The query is for retrieval, not for the user to read. Skip pleasantries, leading filler ("ok", "так"), and rephrasing — keep nouns, names, IDs, technical terms.
- If the current message is already self-contained (clear nouns and intent, no pronouns or anaphora to resolve), echo it verbatim inside the envelope.
- If there is genuinely nothing to disambiguate against (history empty, no clear referent), output the literal token NONE.

Output exactly one line, in this envelope: <rewritten_query>...</rewritten_query>
No reasoning, no extra lines, no markdown.
`;

/**
 * Build the rewriter prompt. The stable preamble is appended to the
 * variable tail (history + current message + output marker).
 */
export function buildRewriterPrompt(input: RewriterPromptInput): string {
  const historyLines = input.history
    .map((turn) => {
      const tag = turn.role === "user" ? "USER" : "ASSISTANT";
      return `${tag}: ${clampLine(turn.text, REWRITER_LINE_CHAR_CAP)}`;
    })
    .join("\n");
  const tail = `\n### history\n${historyLines.length > 0 ? `${historyLines}\n` : ""}\n### current\nUSER: ${clampLine(input.currentMessage, REWRITER_CURRENT_CHAR_CAP)}\n\n### output\n`;
  return `${QUERY_REWRITER_STABLE_PREFIX}${tail}`;
}

function clampLine(raw: string, cap: number): string {
  const normalised = raw.replace(/\s+/g, " ").trim();
  if (normalised.length <= cap) return normalised;
  return `${normalised.slice(0, cap - 1)}…`;
}
