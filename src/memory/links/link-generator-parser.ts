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
