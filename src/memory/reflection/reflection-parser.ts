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
  /**
   * Memory-v2 phase 4. Cross-key supersession hint lifted from a
   * trailing `[valid_from=now; supersedes=KEY]` marker. When set,
   * the writer should mark the active row for this key as
   * superseded by the new row in addition to the structural
   * same-key chaining handled by the partial unique index.
   *
   * Same-key supersession (e.g. `language: ru → en`) **does not**
   * require this field — `ProfileStore.set` auto-chains every
   * write. The field exists only for the rare cross-key case
   * (e.g. `SET full_name=Alex [supersedes=name]`).
   */
  supersedes: string | null;
  /**
   * Memory-v2 phase 4. Currently always `"now"` when the marker is
   * present, `null` otherwise. The store ignores any explicit
   * timestamp — `valid_from` is always stamped from the runner's
   * injected clock to prevent the LLM from rewriting past history.
   * Carried through the parser so future versions can lift the
   * restriction without a re-parse.
   */
  validFrom: "now" | null;
}

export interface ReflectionNote {
  body: string;
  tags: string[];
}

/**
 * Memory-v2 phase 3. Metadata-only refinement of an existing memory's
 * `tags` column. `content` is **never** carried here — the runner
 * surface (`MemoryStore.evolveTags`) also does not accept content
 * mutations, so the append-only invariant on `MemoryEntry.content`
 * stays defended at two layers.
 *
 * `targetId` is the numeric id referenced by `EVOLVE #<id>` in the
 * grammar. The runner is responsible for dropping ids that fall
 * outside the surfaced allowlist for the turn (anti-feedback guard
 * mirroring phase 2's link-generator).
 */
export interface ReflectionEvolve {
  targetId: number;
  /**
   * Tags to **add** to the target memory's existing tag set. Always
   * merge-semantics, never replace — the store implements the union.
   * Deduplicated and lower-cased by the parser.
   */
  addTags: string[];
}

/**
 * Discriminated union returned by `parseReflectionOutput`. `"none"`
 * means the model emitted the literal `NONE` token (or every line was
 * malformed). `"facts"` carries whatever landed in any of the three
 * extraction channels — the name is historical; after phase 3 it
 * covers SET facts, NOTE bodies, AND EVOLVE directives.
 */
export type ParsedReflection =
  | {
      kind: "none";
      facts: readonly ReflectionFact[];
      notes: readonly ReflectionNote[];
      evolves: readonly ReflectionEvolve[];
    }
  | {
      kind: "facts";
      facts: readonly ReflectionFact[];
      notes: readonly ReflectionNote[];
      evolves: readonly ReflectionEvolve[];
    };

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
    return { kind: "none", facts: [], notes: [], evolves: [] };
  }

  const byKey = new Map<string, ReflectionFact>();
  const notes: ReflectionNote[] = [];
  // Deduplicate EVOLVE entries by targetId — multiple EVOLVE lines
  // against the same target collapse into one (last writer wins on
  // tags, then merged by the store).
  const evolvesByTarget = new Map<number, ReflectionEvolve>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) continue;
    const set = parseSetLine(trimmed);
    if (set) {
      byKey.set(set.key, set);
      continue;
    }
    const note = parseNoteLine(trimmed);
    if (note) {
      notes.push(note);
      continue;
    }
    const evolve = parseEvolveLine(trimmed);
    if (evolve) evolvesByTarget.set(evolve.targetId, evolve);
  }

  if (byKey.size === 0 && notes.length === 0 && evolvesByTarget.size === 0) {
    return { kind: "none", facts: [], notes: [], evolves: [] };
  }

  const facts: ReflectionFact[] = [];
  for (const fact of byKey.values()) facts.push(fact);
  const evolves: ReflectionEvolve[] = [];
  for (const evolve of evolvesByTarget.values()) evolves.push(evolve);
  return { kind: "facts", facts, notes, evolves };
}

/**
 * Memory-v2 phase 3. Recognise `EVOLVE #<id> [tags=a,b,c]`.
 *
 * Strict shape: the `#<id>` is required (a parser-side guarantee
 * against the model emitting tag-only updates that we can't route
 * anywhere) and the `[tags=...]` marker must be present and non-empty
 * (a tag-less evolve has no effect — the runner would skip it anyway,
 * but rejecting at parse time keeps the surface small).
 */
const EVOLVE_RE = /^EVOLVE\s+#(\d+)\s+\[tags=([^\]]*)\]\s*$/;
const EVOLVE_TAG_MAX_LENGTH = 40;
const EVOLVE_MAX_TAGS = 10;

function parseEvolveLine(line: string): ReflectionEvolve | null {
  const match = EVOLVE_RE.exec(line);
  if (!match) return null;
  const targetId = Number(match[1]);
  if (!Number.isInteger(targetId) || targetId <= 0) return null;
  const addTags = extractEvolveTags(match[2] ?? "");
  if (addTags.length === 0) return null;
  return { targetId, addTags };
}

function extractEvolveTags(raw: string): string[] {
  const parts = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(
      (t) =>
        /^[a-z0-9][a-z0-9_-]*$/.test(t) && t.length <= EVOLVE_TAG_MAX_LENGTH,
    );
  const deduped: string[] = [];
  for (const tag of parts) {
    if (deduped.length >= EVOLVE_MAX_TAGS) break;
    if (!deduped.includes(tag)) deduped.push(tag);
  }
  return deduped;
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
  let supersedes: string | null = null;
  let validFrom: "now" | null = null;
  const markerMatch = body.match(/\s*\[([^\]]*)\]\s*$/);
  if (
    markerMatch &&
    /pinned\s*=|keywords\s*=|valid_from\s*=|supersedes\s*=/.test(
      markerMatch[1] ?? "",
    )
  ) {
    const inner = markerMatch[1] ?? "";
    body = body.slice(0, markerMatch.index ?? 0).trimEnd();
    const extracted = extractSetMarker(inner);
    pinned = extracted.pinned;
    keywords = extracted.keywords;
    supersedes = extracted.supersedes;
    validFrom = extracted.validFrom;
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
    supersedes,
    validFrom,
  };
}

const SET_KEYWORD_MAX_LENGTH = 40;
const SET_KEYWORDS_MAX = 8;

function extractSetMarker(inner: string): {
  pinned: boolean;
  keywords: string[];
  supersedes: string | null;
  validFrom: "now" | null;
} {
  let pinned = true;
  let keywords: string[] = [];
  let supersedes: string | null = null;
  let validFrom: "now" | null = null;
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
    } else if (name === "supersedes") {
      supersedes = parseSupersedesKey(rhs);
    } else if (name === "valid_from") {
      validFrom = parseValidFromMarker(rhs);
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
  return { pinned, keywords, supersedes, validFrom };
}

/**
 * Memory-v2 phase 4. Recognise the RHS of `supersedes=KEY`. The
 * allowed shape mirrors the same `KEY_PATTERN` ProfileStore uses so
 * a marker that cannot become a valid `set()` parameter is dropped
 * at parse time instead of throwing inside the writer.
 */
const SUPERSEDES_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.\-]{0,119}$/;
function parseSupersedesKey(rhs: string): string | null {
  const trimmed = rhs.trim();
  if (trimmed.length === 0) return null;
  return SUPERSEDES_KEY_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Memory-v2 phase 4. Only the literal token `now` is accepted today.
 * Any other RHS (explicit timestamp, future date, etc.) is dropped
 * silently — the runner always stamps `valid_from` from the live
 * clock so the LLM cannot rewrite past history.
 */
function parseValidFromMarker(rhs: string): "now" | null {
  return rhs.trim().toLowerCase() === "now" ? "now" : null;
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
