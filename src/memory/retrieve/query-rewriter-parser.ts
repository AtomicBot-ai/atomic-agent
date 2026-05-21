/**
 * v2.5 query rewriter (Phase A) — completion parser.
 *
 * Recognises the `<rewritten_query>...</rewritten_query>` envelope
 * emitted under {@link QUERY_REWRITER_GRAMMAR}. Returns the trimmed
 * inner string clamped to {@link REWRITTEN_QUERY_MAX_LENGTH}, or
 * `null` when:
 *
 *  - the envelope is missing,
 *  - the inner string is empty or whitespace-only,
 *  - the inner string is the literal token `NONE` (rewriter opted
 *    out — the prompt allows this as the abstain signal).
 *
 * Callers fold `null` into "use the raw user message as the recall
 * query" — the runner's `maybeRewrite` honours that contract.
 *
 * Hardened: the parser ignores leading / trailing whitespace and
 * any trailing newline, but rejects multi-line bodies (the grammar
 * already forbids `\n` inside `body`; the defensive check below
 * catches replay scenarios where the grammar is bypassed).
 */

/** Hard ceiling on the rewritten query length (matches grammar `body`). */
export const REWRITTEN_QUERY_MAX_LENGTH = 400;

/**
 * Marker for "rewriter abstained" — the prompt asks the model to
 * emit `<rewritten_query>NONE</rewritten_query>` when no
 * disambiguation is possible. We treat that identically to a parse
 * failure: caller falls back to the raw user message.
 */
const ABSTAIN_TOKEN = "NONE";

const ENVELOPE_RE = /<rewritten_query>([^<]*)<\/rewritten_query>/i;

export function parseRewriterOutput(raw: string): string | null {
  const match = ENVELOPE_RE.exec(raw);
  if (!match) return null;
  const inner = (match[1] ?? "").trim();
  if (inner.length === 0) return null;
  if (inner === ABSTAIN_TOKEN) return null;
  if (inner.includes("\n")) return null;
  return inner.length > REWRITTEN_QUERY_MAX_LENGTH
    ? inner.slice(0, REWRITTEN_QUERY_MAX_LENGTH)
    : inner;
}
