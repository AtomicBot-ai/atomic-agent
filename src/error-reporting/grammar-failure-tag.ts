/**
 * The `grammar_path` and `grammar_skipped` tags of an error report
 * (ATO-2422).
 *
 * A `GrammarError` reached Sentry as one class for two stories with
 * different fixes: a llama-server that refused the request (its grammar,
 * or something else in it) and a reply our parser could not read even
 * after the one-shot repair. `cause_type` and `http_status` hint at the
 * split but do not say whether a 400 named the grammar, and nothing said
 * whether the unreadable reply came from a server that had already
 * refused the grammar (ATO-1675) and so answered in free text. These
 * tags say it in fixed words:
 *
 *  - `grammar_path`: `server_refused_grammar`, `server_refused_request`,
 *    `parse_failed` or `repair_failed`, read off `GrammarError.path`;
 *  - `grammar_skipped`: `yes` when the failed reply was served without
 *    the grammar, else `no`; sent for `repair_failed` only, the one path
 *    that knows.
 *
 * Read by class name, so this module takes no import from the LLM
 * layer, and walked through `cause` like the other tag readers. Never
 * the message, the raw preview or the model's text. Outside the
 * fingerprint: no live issue re-groups.
 */

/** Mirror of `GrammarFailurePath` in `src/llm/reliability/failure-category.ts`. */
const KNOWN_GRAMMAR_PATHS: ReadonlySet<string> = new Set([
  "server_refused_grammar",
  "server_refused_request",
  "parse_failed",
  "repair_failed",
]);

/** Depth cap on the `cause` walk; longer is a cycle. */
const MAX_CAUSE_DEPTH = 5;

/** The tags for `err`, or `undefined` when no tagged `GrammarError` is on its chain. */
export function extractGrammarFailureTags(
  err: unknown,
): Record<string, string> | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const record = current as { name?: unknown; path?: unknown; grammarSkipped?: unknown; cause?: unknown };
    if (record.name === "GrammarError") {
      const path = record.path;
      if (typeof path !== "string" || !KNOWN_GRAMMAR_PATHS.has(path)) return undefined;
      const tags: Record<string, string> = { grammar_path: path };
      if (path === "repair_failed") {
        tags.grammar_skipped = record.grammarSkipped === true ? "yes" : "no";
      }
      return tags;
    }
    if (record.cause === current) return undefined;
    current = record.cause;
  }
  return undefined;
}
