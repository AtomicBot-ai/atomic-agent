import type { ProfileFact } from "./profile-store.js";

export interface RenderProfileOptions {
  /**
   * Current user message used to gate contextual (pinned=false) facts.
   * When undefined or empty, contextual facts are suppressed entirely.
   *
   * Gating strategy is a conservative case-insensitive whole-word
   * substring match against the message — enough to catch obvious
   * topical overlaps without burning embedding budget on every turn.
   */
  userMessage?: string | null;
  /**
   * Master switch for the contextual keyword gate. When `false`, every
   * fact is rendered regardless of pinned/keywords (pre-gate behaviour).
   * Defaults to `true`.
   */
  contextualKeywordGate?: boolean;
  /**
   * Memory-v2 phase 7a. Strictly-positive threshold for vote-score
   * suppression. A fact with `voteScore <= -profileFilterThreshold`
   * is hidden from the rendered output regardless of pinned/keyword
   * status — operators downvoted it explicitly. `0` or `undefined`
   * disables the filter entirely (back-compat).
   */
  profileFilterThreshold?: number;
}

/**
 * Render the contents of the `### profile` prompt section. This lives in
 * the variable tail of the prompt (never the stable prefix) so the KV
 * cache does not invalidate when the profile is edited between turns.
 *
 * Output format (stable, sorted by key):
 *   - language: ru
 *   - name: Alex
 *   - timezone: Europe/Moscow
 *
 * When the gate is enabled, facts with `pinned=false` are only emitted
 * if at least one of their `keywords` matches the current user message.
 * Pinned facts are always emitted; this preserves back-compat for all
 * rows migrated from schema v2 (which default to pinned=1).
 *
 * When the resulting list is empty we emit a sentinel line so downstream
 * budget/estimate code does not have to special-case the zero state.
 */
export function renderProfileSection(
  facts: readonly ProfileFact[],
  options: RenderProfileOptions = {},
): string {
  const gate = options.contextualKeywordGate ?? true;
  const message = (options.userMessage ?? "").toLowerCase();
  // Phase 7a — vote-driven suppression. Applied **before** the
  // contextual-keyword gate so a downvoted pinned fact disappears
  // too (operators expect downvotes to override pinning).
  const threshold = options.profileFilterThreshold ?? 0;
  const voteHidden = (fact: ProfileFact): boolean =>
    threshold > 0 && fact.voteScore <= -threshold;

  const filtered = facts.filter((fact) => {
    if (voteHidden(fact)) return false;
    if (!gate) return true;
    if (fact.pinned) return true;
    if (!message) return false;
    if (fact.keywords.length === 0) return false;
    return fact.keywords.some((keyword) => matchesKeyword(message, keyword));
  });

  if (filtered.length === 0) return "(no profile)";
  const sorted = [...filtered].sort((a, b) => a.key.localeCompare(b.key));
  return sorted
    .map((fact) => `- ${fact.key}: ${escapeValue(fact.value)}`)
    .join("\n");
}

/**
 * Multi-line profile values are replaced with `\n` in the rendered line
 * so a single fact always occupies a single prompt line. Callers that
 * need the raw multi-line value should read it from the store directly.
 */
function escapeValue(raw: string): string {
  if (!raw.includes("\n") && !raw.includes("\r")) return raw;
  return raw.replace(/\r?\n/g, " \\n ").replace(/\r/g, " \\r ");
}

/**
 * Whole-word, case-insensitive keyword match. Word boundaries are
 * approximated as any non-alphanumeric/underscore char — good enough
 * for keyword hits like "deploy" inside "how do I deploy this?".
 */
function matchesKeyword(haystack: string, keyword: string): boolean {
  const needle = keyword.toLowerCase();
  if (needle.length === 0) return false;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) return false;
    const before = idx === 0 ? "" : haystack[idx - 1]!;
    const afterIdx = idx + needle.length;
    const after = afterIdx >= haystack.length ? "" : haystack[afterIdx]!;
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = idx + 1;
  }
}

function isWordChar(ch: string): boolean {
  if (ch === "") return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}
