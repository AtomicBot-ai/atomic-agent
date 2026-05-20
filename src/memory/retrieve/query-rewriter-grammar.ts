/**
 * memU-inspired query rewriter (Phase A) — GBNF grammar.
 *
 * Constrains the rewriter completion to a single
 * `<rewritten_query>...</rewritten_query>` envelope. The body is
 * bounded to 400 characters to cap downstream BM25 query cost
 * (longer "queries" tend to degrade FTS5 ranking via term explosion).
 *
 * The grammar is intentionally tiny so the rewriter completion stays
 * cheap (~one round-trip to llama-server on `slotId = -1` with
 * minimal completion tokens). Module-level constant — KV cache for
 * this string lives on whichever slot the rewriter happens to land
 * on; using `slotId = -1` means no cache reuse, which is the
 * canonical "cold call" path that never touches the main agent slot
 * or the reflection slot.
 *
 * Body alphabet excludes `<` to forbid nested tags inside the
 * envelope; everything else is allowed so multilingual messages
 * survive verbatim.
 */
export const QUERY_REWRITER_GRAMMAR = `root        ::= "<rewritten_query>" body "</rewritten_query>" "\\n"?
body        ::= [^<\\n]{1,400}
`;
