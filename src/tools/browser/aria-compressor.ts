import { createHash } from "node:crypto";

export interface AriaSnapshotSummary {
  text: string;
  digest: string;
  refs: string[];
}

export interface AriaCompressionOptions {
  /**
   * Hard cap applied AFTER noise removal. Default 800 gives modern
   * content-heavy pages (GitHub repo view with a long README, Amazon
   * product pages, docs sites) enough room to retain the actual body
   * text after noise removal, while still bounding a pathological tree.
   * The previous 300-line cap was measured to truncate GitHub READMEs
   * before the model ever saw them, which drove "click Code again"
   * failure modes.
   */
  maxLines?: number;
  /**
   * Soft character budget applied AFTER noise removal and BEFORE the
   * line cap. Dense SPAs can emit short lines that still blow small
   * local-model context windows (8k–16k). Default ~24k chars ≈ a few
   * thousand tokens of ARIA text — enough for useful refs, small enough
   * that a 9B/ local chat model still has room for the stable prefix.
   * Set `0` / Infinity to disable. Related: #21.
   */
  maxChars?: number;
  /**
   * Drop pure container lines (`generic`, `group`, `none`, ...) that
   * carry no name and no inline text. Default true; tests set false to
   * verify the raw-line pathway.
   */
  dropNoise?: boolean;
}

/** Default char budget when callers omit `maxChars`. */
export const DEFAULT_ARIA_MAX_CHARS = 24_000;

/**
 * Roles that convey no semantic signal to the model on their own: empty
 * wrappers that exist only to group children. Playwright's AI-mode
 * ariaSnapshot is full of these on modern SPA pages (DuckDuckGo, GitHub,
 * Amazon), and they push the actual interactive nodes off the budget.
 */
const NOISE_ROLES = new Set([
  "generic",
  "group",
  "none",
  "presentation",
  "paragraph",
]);

/** Matches "- <role>[ ...]..." — a Playwright AI-mode tree node. */
const LINE_PATTERN =
  /^-\s+([A-Za-z][A-Za-z0-9_-]*)(.*)$/;
const NAME_PATTERN = /^\s+"/;
const REF_PATTERN = /\[ref=([A-Za-z0-9]+)\]/;

interface ParsedLine {
  indent: number;
  role: string;
  hasName: boolean;
  ref: string | null;
  /** Text that follows the last colon on the line, trimmed. */
  textAfterColon: string;
}

function parseLine(raw: string): ParsedLine | null {
  const indentMatch = /^(\s*)/.exec(raw);
  const indent = indentMatch ? indentMatch[1]!.length : 0;
  const body = raw.slice(indent);
  const match = LINE_PATTERN.exec(body);
  if (!match) return null;
  const role = match[1]!;
  const rest = match[2]!;
  const hasName = NAME_PATTERN.test(rest);
  const refMatch = REF_PATTERN.exec(rest);
  const ref = refMatch ? refMatch[1]! : null;
  // The colon separates metadata (role/name/ref/flags) from inline text.
  // We take the segment after the last colon to avoid picking up colons
  // inside a quoted name.
  const colonIdx = rest.lastIndexOf(":");
  const textAfterColon =
    colonIdx >= 0 ? rest.slice(colonIdx + 1).trim() : "";
  return { indent, role, hasName, ref, textAfterColon };
}

function isNoiseLine(parsed: ParsedLine): boolean {
  return (
    NOISE_ROLES.has(parsed.role) &&
    !parsed.hasName &&
    parsed.textAfterColon.length === 0
  );
}

/**
 * Normalises a raw Playwright AI-mode aria snapshot into a compact block
 * suitable for prompt injection.
 *
 * Pipeline:
 *  1. Drop "noise" container lines (generic/group/none with no name and
 *     no inline text) — typical SPA pages have 60-80% such wrappers.
 *  2. Apply `maxLines` as a final safety cap; footer reports how many
 *     lines were collapsed and how many were truncated.
 *  3. Re-extract refs from the compressed body so the model only learns
 *     refs it can actually reason about.
 *  4. Compute a deterministic digest for change detection between steps.
 */
export function summariseAriaSnapshot(
  rawText: string,
  meta: { url: string; title: string },
  options: AriaCompressionOptions = {},
): AriaSnapshotSummary {
  const maxLines = options.maxLines ?? 800;
  const maxChars =
    options.maxChars === undefined
      ? DEFAULT_ARIA_MAX_CHARS
      : options.maxChars <= 0 || !Number.isFinite(options.maxChars)
        ? Number.POSITIVE_INFINITY
        : Math.max(1, Math.trunc(options.maxChars));
  const dropNoise = options.dropNoise ?? true;

  const rawLines = rawText.split(/\r?\n/);
  const kept: string[] = [];
  let droppedNoise = 0;
  for (const line of rawLines) {
    if (dropNoise) {
      const parsed = parseLine(line);
      if (parsed && isNoiseLine(parsed)) {
        droppedNoise += 1;
        continue;
      }
    }
    kept.push(line);
  }

  // Prefer keeping interactive / named nodes when we must cut by chars:
  // score lines with refs or quoted names higher and pack greedily in
  // original order until the budget fills (order-preserving pack).
  const charPacked = packLinesToCharBudget(kept, maxChars);
  const afterChars = charPacked.lines;
  const truncatedByChars = charPacked.truncated;
  const omittedCharsByBudget = charPacked.omittedChars;

  const truncatedByLimit = afterChars.length > maxLines;
  const finalLines = truncatedByLimit ? afterChars.slice(0, maxLines) : afterChars;
  const omittedByLimit = afterChars.length - finalLines.length;
  const omittedCharsByLines = truncatedByLimit
    ? afterChars.slice(maxLines).reduce((sum, line) => sum + line.length + 1, 0)
    : 0;

  const body = finalLines.join("\n");
  const footerParts: string[] = [];
  if (droppedNoise > 0) {
    footerParts.push(
      `… [collapsed ${droppedNoise} empty container lines]`,
    );
  }
  if (truncatedByChars) {
    footerParts.push(
      `… [truncated ARIA tree by size; ~${omittedCharsByBudget} chars over budget — scroll or navigate to see more]`,
    );
  }
  if (truncatedByLimit) {
    footerParts.push(
      `… [truncated ARIA tree; ${omittedByLimit} lines / ~${omittedCharsByLines} chars omitted — scroll or navigate to see more]`,
    );
  }
  const footer = footerParts.length > 0 ? `\n${footerParts.join("\n")}` : "";

  const text = [
    `url: ${meta.url}`,
    `title: ${meta.title}`,
    "",
    body + footer,
  ]
    .join("\n")
    .trimEnd();

  const refs = extractRefs(body);
  const digest = createHash("sha1")
    .update(`${meta.url}\n${text}`)
    .digest("hex")
    .slice(0, 12);
  return { text, digest, refs };
}

/**
 * Order-preserving pack: include lines in their original order until adding
 * the next line would exceed `maxChars`, then cut the tail. Lines near the
 * top of the tree survive — which is what the model almost always acts on
 * first — but there is no per-line ref/name scoring; packing is purely
 * positional.
 */
export function packLinesToCharBudget(
  lines: readonly string[],
  maxChars: number,
): { lines: string[]; truncated: boolean; omittedChars: number } {
  if (!Number.isFinite(maxChars) || maxChars === Number.POSITIVE_INFINITY) {
    return { lines: [...lines], truncated: false, omittedChars: 0 };
  }
  if (maxChars <= 0) {
    return { lines: [], truncated: lines.length > 0, omittedChars: lines.join("\n").length };
  }
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    // +1 for the join newline, except before the first line.
    const add = line.length + (out.length > 0 ? 1 : 0);
    if (used + add > maxChars) {
      const omittedChars = lines
        .slice(i)
        .reduce((sum, l, idx) => sum + l.length + (idx > 0 || out.length > 0 ? 1 : 0), 0);
      return { lines: out, truncated: true, omittedChars };
    }
    out.push(line);
    used += add;
  }
  return { lines: out, truncated: false, omittedChars: 0 };
}

function extractRefs(rawText: string): string[] {
  const pattern = /\[ref=([a-zA-Z0-9]+)\]/g;
  const seen = new Set<string>();
  for (const match of rawText.matchAll(pattern)) {
    seen.add(match[1]!);
  }
  return Array.from(seen);
}
