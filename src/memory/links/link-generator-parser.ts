import { isLinkKind, type LinkKind } from "./link-store.js";

/**
 * Memory-v2 phase 2. Parser for the `link-generator` sub-call.
 *
 * Strict contract:
 *   - Empty body, the literal `NONE`, or whitespace-only ⇒
 *     `{ kind: "none" }`.
 *   - Otherwise each line must match `LINK <from> <to> [kind=<KIND>]`.
 *     Bad lines are silently skipped — one malformed line never
 *     invalidates the whole batch.
 *   - Self-loops (from == to) are rejected: they add no recall
 *     signal and the LinkStore would refuse the insert anyway. We
 *     filter early to avoid one round-trip through validation.
 *   - The caller supplies an `allowlist` of legitimate memory ids
 *     (the surfaced set for this turn). Links whose endpoints are
 *     not in the allowlist are dropped. This is the
 *     anti-feedback-loop guard mirrored from phase 7a invariant 18.
 *   - A hard cap of `maxLinks` (default 4 — matches the grammar)
 *     is applied after filtering so a runaway completion can't
 *     pollute the graph.
 *   - Duplicate `(from, to, kind)` triples within the same payload
 *     collapse to the first occurrence.
 */
export interface ParsedLink {
  fromId: number;
  toId: number;
  kind: LinkKind;
}

export type ParsedLinkGeneratorOutput =
  | { kind: "none" }
  | { kind: "links"; links: ParsedLink[] };

export interface ParseOptions {
  /** Ids the LLM is allowed to reference. Required. */
  allowlist: ReadonlySet<number>;
  /** Hard cap on emitted links. Default 4. */
  maxLinks?: number;
}

const LINE_RE =
  /^LINK\s+(\d+)\s+(\d+)\s+\[kind=([A-Z_]+)\]\s*$/;

export function parseLinkGeneratorOutput(
  raw: string,
  opts: ParseOptions,
): ParsedLinkGeneratorOutput {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "none" };
  if (/^NONE\s*$/i.test(trimmed)) return { kind: "none" };

  // Cloud providers driven by Structured Outputs (see
  // `LINK_GENERATOR_RESPONSE_FORMAT`) emit JSON instead of the legacy
  // text grammar. Try the JSON shape first when the body looks like
  // JSON — on success we use those triples; on failure we fall through
  // to the line-based grammar parser so the local llama path stays
  // byte-identical.
  if (looksLikeJson(trimmed)) {
    const fromJson = parseJsonShape(trimmed, opts);
    if (fromJson) return fromJson;
  }

  const max = opts.maxLinks ?? 4;
  const seen = new Set<string>();
  const out: ParsedLink[] = [];

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = LINE_RE.exec(line);
    if (!match) continue;
    const fromId = Number(match[1]);
    const toId = Number(match[2]);
    const kindRaw = match[3] ?? "";
    if (!Number.isInteger(fromId) || fromId <= 0) continue;
    if (!Number.isInteger(toId) || toId <= 0) continue;
    if (fromId === toId) continue;
    if (!isLinkKind(kindRaw)) continue;
    if (!opts.allowlist.has(fromId)) continue;
    if (!opts.allowlist.has(toId)) continue;
    const dedupKey = `${fromId}->${toId}::${kindRaw}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({ fromId, toId, kind: kindRaw });
    if (out.length >= max) break;
  }

  if (out.length === 0) return { kind: "none" };
  return { kind: "links", links: out };
}

function looksLikeJson(s: string): boolean {
  return s.startsWith("{") || s.startsWith("[");
}

/**
 * Parse the Structured Outputs JSON shape:
 *   { "kind": "none" }
 *   { "kind": "links", "links": [{ from_id, to_id, link_kind }] }
 *
 * Returns null on any structural / type mismatch so the caller can
 * fall back to the legacy line grammar parser. The same allowlist /
 * self-loop / max-links / dedup invariants apply as the text path —
 * structural validity (Structured Outputs catches that on the server)
 * never implies semantic legitimacy.
 */
function parseJsonShape(
  raw: string,
  opts: ParseOptions,
): ParsedLinkGeneratorOutput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const kindField = obj["kind"];
  if (kindField === "none") {
    return { kind: "none" };
  }
  if (kindField !== "links") {
    return null;
  }
  const linksField = obj["links"];
  if (!Array.isArray(linksField)) {
    return null;
  }
  const max = opts.maxLinks ?? 4;
  const seen = new Set<string>();
  const out: ParsedLink[] = [];
  for (const entry of linksField) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const fromId = toPositiveInt(rec["from_id"]);
    const toId = toPositiveInt(rec["to_id"]);
    const kindRaw = typeof rec["link_kind"] === "string" ? rec["link_kind"] : "";
    if (fromId === null || toId === null) continue;
    if (fromId === toId) continue;
    if (!isLinkKind(kindRaw)) continue;
    if (!opts.allowlist.has(fromId)) continue;
    if (!opts.allowlist.has(toId)) continue;
    const dedupKey = `${fromId}->${toId}::${kindRaw}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({ fromId, toId, kind: kindRaw });
    if (out.length >= max) break;
  }
  if (out.length === 0) return { kind: "none" };
  return { kind: "links", links: out };
}

function toPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}
