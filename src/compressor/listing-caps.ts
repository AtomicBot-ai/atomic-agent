/**
 * Per-call compressor bounds for tools whose output is an ORDERED
 * LISTING: an optional header line followed by one row per record,
 * newest (or most relevant) first.
 *
 * `compressToolResult`'s runtime-wide defaults are tuned for log-tail
 * tools (`os.shell.run`, `os.fs.grep`): keep the LAST 12 non-blank
 * lines, then head-slice the survivors to 385 chars. For a log that is
 * right — the interesting part of a build log is its end. For a
 * listing it is doubly wrong:
 *
 *   1. keeping the last 12 lines throws away the NEWEST rows (and the
 *      header, which is line 1), and
 *   2. the 385-char head-slice then leaves three to five rows.
 *
 * The rows are not paged — they are gone. The compressed `summary` is
 * what gets stored as the tool_result turn, and `details` (which holds
 * the full structured list) is dropped by `applyStateEffects`, which
 * lifts out only `toolLoaded` / `skillLoaded` / `worldSnapshot`. So
 * this is ingestion loss, not a rendering detail: the model never sees
 * the rows and re-calls the tool trying to find them.
 *
 * `MCP_COMPRESSOR_OPTIONS` (src/mcp/mcp-tool-adapter.ts) and
 * `INBOX_RESULT_CAPS` (src/tools/os/email.ts) already opt their
 * listings out of this the same way. This helper is that opt-out,
 * shared, so the native listing tools do not each grow a literal.
 *
 * What it does:
 *   - disables line-based tail truncation entirely, so the head-slice
 *     is the only cut and it keeps the header plus the newest rows;
 *   - sizes the head-slice from the row budget the calling tool has
 *     already bound itself to (`limit`, `DEFAULT_LIMIT`, the number of
 *     records it is about to print), clamped to what can actually be
 *     delivered — see {@link MAX_LISTING_SUMMARY_CHARS}.
 *
 * What it does NOT do: it is not a promise that the listing survives
 * byte for byte. `extractTail` drops blank lines unconditionally, and
 * nothing clamps the variable field in a row (a commit subject, an
 * issue title, a `ps` command path), so the per-row numbers callers
 * pass are measured estimates, not ceilings. The clamp below is the
 * only hard bound.
 */

/**
 * Shape of the options bag `compressToolResult` accepts. Declared
 * structurally rather than imported so this module stays independent
 * of `result-compressor.ts`'s exported types.
 */
export interface ListingResultCaps {
  maxSummaryLength: number;
  maxTailLines: number;
}

/**
 * Hard ceiling on any single listing result, in characters.
 *
 * 8 000 is not a taste call: it is `TOOL_RESULT_RENDER_CAP_CHARS`
 * (src/session/conversation-turn.ts), the cap `renderToolResultBody`
 * puts on every tool_result body — including the inference that
 * consumes the result. The only escapes are
 * `TOOLS_FULL_BODY_WHEN_FRESH` (`os.http.request` alone), the fresh
 * gog-shell case and `fusion.delegate`; no listing tool is in any of
 * them. A `maxSummaryLength` above 8 000 is therefore a dead number —
 * the surplus is stored on the turn, re-clipped on every render, and
 * never reaches the model. `MCP_COMPRESSOR_OPTIONS` lands on exactly
 * 8 000 for the same reason.
 *
 * Raising this means adding these tools to
 * `TOOLS_FULL_BODY_WHEN_FRESH`, which is a prompt-budget policy call,
 * not a bug fix.
 */
export const MAX_LISTING_SUMMARY_CHARS = 8_000;

/**
 * Bounds for a listing of at most `rows` rows whose rows run to about
 * `charsPerRow` characters.
 *
 * Budget = (rows + 1) * charsPerRow — the +1 pays for the header line
 * (`# branch:`, the repo slug, the `PID PPID USER …` column row) so a
 * full listing never spends its last characters on the header and
 * drops a row, and so a header-only listing still has room. The result
 * is clamped to `MAX_LISTING_SUMMARY_CHARS`: bounded, never unbounded.
 */
export function listingResultCaps(
  rows: number,
  charsPerRow: number,
): ListingResultCaps {
  const budget = (Math.max(0, Math.floor(rows)) + 1) * charsPerRow;
  return {
    maxSummaryLength: Math.min(MAX_LISTING_SUMMARY_CHARS, budget),
    // Number.MAX_SAFE_INTEGER, not a big number: `extractTail` keeps
    // the LAST N lines, which is exactly backwards for an ordered
    // list. Any finite N would eventually eat the newest rows.
    maxTailLines: Number.MAX_SAFE_INTEGER,
  };
}
