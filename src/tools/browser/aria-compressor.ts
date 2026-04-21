import { createHash } from "node:crypto";

export interface AriaSnapshotSummary {
  text: string;
  digest: string;
  refs: string[];
}

export interface AriaCompressionOptions {
  /**
   * Hard cap applied AFTER noise removal. Default 300 keeps the typical
   * DDG/GitHub/Amazon page fully readable while still bounding a
   * pathological tree.
   */
  maxLines?: number;
  /**
   * Drop pure container lines (`generic`, `group`, `none`, ...) that
   * carry no name and no inline text. Default true; tests set false to
   * verify the raw-line pathway.
   */
  dropNoise?: boolean;
}

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
  const maxLines = options.maxLines ?? 300;
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

  const truncatedByLimit = kept.length > maxLines;
  const finalLines = truncatedByLimit ? kept.slice(0, maxLines) : kept;
  const omittedByLimit = kept.length - finalLines.length;

  const body = finalLines.join("\n");
  const footerParts: string[] = [];
  if (droppedNoise > 0) {
    footerParts.push(
      `… [collapsed ${droppedNoise} empty container lines]`,
    );
  }
  if (truncatedByLimit) {
    footerParts.push(
      `… [truncated ARIA tree; ${omittedByLimit} lines omitted]`,
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

function extractRefs(rawText: string): string[] {
  const pattern = /\[ref=([a-zA-Z0-9]+)\]/g;
  const seen = new Set<string>();
  for (const match of rawText.matchAll(pattern)) {
    seen.add(match[1]!);
  }
  return Array.from(seen);
}
