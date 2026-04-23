/**
 * Parse the completion produced under `REFLECTION_GRAMMAR`. The grammar
 * already guarantees the raw shape, but we still validate defensively
 * because the parser also runs in non-grammar test paths and against
 * legacy completions.
 *
 * The parser recognises three alternatives on each non-empty line:
 *  - `SET key=value`   → structured profile fact (flows into ProfileStore)
 *  - `NOTE body`       → freeform note (flows into MemoryStore). The
 *    body may carry an optional trailing ` [tags=a,b,c]` marker which
 *    is stripped out post-hoc and returned as `tags`.
 *  - literal `NONE`    → nothing to remember
 *
 * The parser is tolerant of the exact line terminator (LF / CRLF / none)
 * and optional trailing whitespace.
 */

export interface ReflectionFact {
  key: string;
  value: string;
  /**
   * `true` when the LLM emitted the default `SET key=value` form (the
   * fact should always render into `### profile`). `false` when the
   * trailing ` [pinned=false; keywords=...]` marker was present — the
   * fact is contextual and only rendered when one of `keywords` hits
   * the current user message. Back-compat default is `true`.
   */
  pinned: boolean;
  /**
   * Contextual-gate keywords, lifted from the trailing
   * `[pinned=false; keywords=a,b,c]` marker. Always `[]` for pinned
   * facts. Deduplicated and lower-cased by the parser so the store
   * always sees canonical values.
   */
  keywords: string[];
}

export interface ReflectionNote {
  body: string;
  tags: string[];
}

/**
 * Discriminated union returned by `parseReflectionOutput`. `"none"`
 * means the model emitted the literal `NONE` token (or every line was
 * malformed). `"facts"` carries whatever landed in either of the two
 * extraction channels — the name is historical; after Increment 0 it
 * covers both SET facts and NOTE bodies.
 */
export type ParsedReflection =
  | { kind: "none"; facts: readonly ReflectionFact[]; notes: readonly ReflectionNote[] }
  | { kind: "facts"; facts: readonly ReflectionFact[]; notes: readonly ReflectionNote[] };

/** Hard ceiling on the rendered NOTE body length (matches grammar `body`). */
const NOTE_BODY_MAX_LENGTH = 500;
/** Hard ceiling on the number of tags pulled out of a NOTE trailing marker. */
const NOTE_MAX_TAGS = 8;
/** Hard ceiling on a single tag string lifted from a NOTE marker. */
const NOTE_TAG_MAX_LENGTH = 40;

/**
 * Parse a reflection completion string.
 *
 * Returns `{ kind: "none" }` when the model declared it has nothing to
 * remember OR when every line was malformed and nothing landed in
 * either channel. Malformed lines are silently skipped; callers rely
 * on downstream store validators to reject garbage. Duplicate SET
 * keys are deduplicated keeping the last value (matches
 * `ProfileStore.set` upsert semantics). NOTEs are NOT deduplicated —
 * reflection emits them rarely and MemoryStore is a log, not a map.
 */
export function parseReflectionOutput(raw: string): ParsedReflection {
  const text = raw.trim();
  if (text.length === 0 || text === "NONE") {
    return { kind: "none", facts: [], notes: [] };
  }

  const byKey = new Map<string, ReflectionFact>();
  const notes: ReflectionNote[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) continue;
    const set = parseSetLine(trimmed);
    if (set) {
      byKey.set(set.key, set);
      continue;
    }
    const note = parseNoteLine(trimmed);
    if (note) notes.push(note);
  }

  if (byKey.size === 0 && notes.length === 0) {
    return { kind: "none", facts: [], notes: [] };
  }

  const facts: ReflectionFact[] = [];
  for (const fact of byKey.values()) facts.push(fact);
  return { kind: "facts", facts, notes };
}

/**
 * Parse a `SET key=value` line, optionally followed by a trailing
 * ` [pinned=false; keywords=a,b,c]` marker. The marker must be the
 * last non-empty segment on the line. When absent the fact defaults
 * to `pinned=true` / `keywords=[]`.
 *
 * We tolerate the separator between `pinned=...` and `keywords=...`
 * being either `;` or `,` and allow either clause to be missing, as
 * long as one of them is present inside the brackets.
 */
function parseSetLine(line: string): ReflectionFact | null {
  if (!line.startsWith("SET ")) return null;
  let body = line.slice(4);

  let pinned = true;
  let keywords: string[] = [];
  const markerMatch = body.match(/\s*\[([^\]]*)\]\s*$/);
  if (markerMatch && /pinned\s*=|keywords\s*=/.test(markerMatch[1] ?? "")) {
    const inner = markerMatch[1] ?? "";
    body = body.slice(0, markerMatch.index ?? 0).trimEnd();
    const extracted = extractSetMarker(inner);
    pinned = extracted.pinned;
    keywords = extracted.keywords;
  }

  const eq = body.indexOf("=");
  if (eq <= 0) return null;
  const key = body.slice(0, eq).trim();
  const value = body.slice(eq + 1);
  if (key.length === 0 || value.length === 0) return null;
  return {
    key,
    value,
    pinned,
    keywords: pinned ? [] : keywords,
  };
}

const SET_KEYWORD_MAX_LENGTH = 40;
const SET_KEYWORDS_MAX = 8;

function extractSetMarker(inner: string): {
  pinned: boolean;
  keywords: string[];
} {
  let pinned = true;
  let keywords: string[] = [];
  // Top-level clauses are separated by `;` only — commas inside
  // `keywords=...` are payload, not clause separators. We also accept
  // a fallback form with a single clause before a comma (pinned=false)
  // when no `;` is present and there is no `keywords=` clause after.
  const topClauses = inner.split(";");
  for (const rawClause of topClauses) {
    const clause = rawClause.trim();
    if (clause.length === 0) continue;
    const eqIdx = clause.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = clause.slice(0, eqIdx).trim().toLowerCase();
    const rhs = clause.slice(eqIdx + 1).trim();
    if (name === "pinned") {
      pinned = rhs.toLowerCase() !== "false";
    } else if (name === "keywords") {
      keywords = parseKeywordList(rhs);
    } else if (name.endsWith(" pinned") || name.endsWith(",pinned")) {
      // Fallback for LLMs that write `pinned=false, keywords=...`
      // without a `;`. We re-tokenise by splitting on commas only
      // when we see a lonely `pinned=false, keywords=...` pattern.
    }
  }
  // Fallback parser for `pinned=false, keywords=a,b,c` without a `;`.
  if (keywords.length === 0 && /keywords\s*=/.test(inner) && !/;/.test(inner)) {
    const kwIdx = inner.toLowerCase().indexOf("keywords");
    if (kwIdx >= 0) {
      const rhs = inner.slice(kwIdx).split("=").slice(1).join("=").trim();
      keywords = parseKeywordList(rhs);
      const pinnedMatch = inner.match(/pinned\s*=\s*([a-zA-Z]+)/);
      if (pinnedMatch) {
        pinned = pinnedMatch[1]!.toLowerCase() !== "false";
      }
    }
  }
  return { pinned, keywords };
}

function parseKeywordList(raw: string): string[] {
  const normalised = raw.replace(/^\[|\]$/g, "");
  const parts = normalised
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(
      (k) =>
        k.length > 0 &&
        k.length <= SET_KEYWORD_MAX_LENGTH &&
        /^[a-z0-9][a-z0-9 _\-./]*$/.test(k),
    );
  const deduped: string[] = [];
  for (const kw of parts) {
    if (deduped.length >= SET_KEYWORDS_MAX) break;
    if (!deduped.includes(kw)) deduped.push(kw);
  }
  return deduped;
}

/**
 * Recognise `NOTE body` with an optional trailing ` [tags=a,b,c]`.
 * The tag marker, when present, must be the last non-empty segment on
 * the line — we tear it off greedily so tags do not leak into the
 * stored content.
 */
function parseNoteLine(line: string): ReflectionNote | null {
  if (!line.startsWith("NOTE ")) return null;
  const payload = line.slice(5).trim();
  if (payload.length === 0) return null;

  let body = payload;
  let tags: string[] = [];
  const tagMatch = payload.match(/\s*\[tags=([^\]]*)\]\s*$/);
  if (tagMatch) {
    body = payload.slice(0, tagMatch.index ?? payload.length - tagMatch[0].length).trimEnd();
    tags = extractTags(tagMatch[1] ?? "");
  }

  if (body.length === 0) return null;
  const clampedBody =
    body.length > NOTE_BODY_MAX_LENGTH
      ? body.slice(0, NOTE_BODY_MAX_LENGTH)
      : body;
  return { body: clampedBody, tags };
}

function extractTags(raw: string): string[] {
  const parts = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => /^[a-z0-9][a-z0-9_-]*$/.test(t) && t.length <= NOTE_TAG_MAX_LENGTH);
  const deduped: string[] = [];
  for (const tag of parts) {
    if (deduped.length >= NOTE_MAX_TAGS) break;
    if (!deduped.includes(tag)) deduped.push(tag);
  }
  return deduped;
}
