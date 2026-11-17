/**
 * One match from `ast-grep run --json=stream` (one JSON object per
 * line) or `--json` / `--json=compact` (one array). Lines and columns
 * from ast-grep are 0-based; these are 1-based, as the other tools
 * print them. Byte offsets are UTF-8 offsets into the file.
 */
export interface AstGrepMatch {
  /** As ast-grep printed it: absolute when the search target was absolute. */
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** The matched source text. */
  text: string;
  /** The full source line(s) the match sits on. */
  lines: string;
  byteStart: number;
  byteEnd: number;
  /** Set when the run had `--rewrite`. */
  replacement?: string;
  /** What the replacement replaces; defaults to the match range. */
  replaceStart?: number;
  replaceEnd?: number;
}

/** Parse ast-grep's JSON output; objects that do not look like matches are skipped. */
export function parseAstGrepJson(stdout: string): AstGrepMatch[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  const raw: unknown[] = [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) raw.push(...parsed);
    } catch {
      // Fall through to the line reader: a truncated array still has
      // whole objects on their own lines in the pretty form.
    }
  }
  if (raw.length === 0) {
    for (const line of trimmed.split(/\r?\n/)) {
      const text = line.trim().replace(/^\[|,$|\]$/g, "").trim();
      if (!text.startsWith("{")) continue;
      try {
        raw.push(JSON.parse(text));
      } catch {
        // A line cut by the output cap: drop it, the caller sees `truncated`.
      }
    }
  }
  const matches: AstGrepMatch[] = [];
  for (const item of raw) {
    const match = toMatch(item);
    if (match !== null) matches.push(match);
  }
  return matches;
}

function toMatch(item: unknown): AstGrepMatch | null {
  if (!isRecord(item)) return null;
  const file = item.file;
  const text = item.text;
  const range = item.range;
  if (typeof file !== "string" || typeof text !== "string" || !isRecord(range)) return null;
  const byteOffset = range.byteOffset;
  const start = range.start;
  const end = range.end;
  if (!isRecord(byteOffset) || !isRecord(start) || !isRecord(end)) return null;
  const byteStart = int(byteOffset.start);
  const byteEnd = int(byteOffset.end);
  const line = int(start.line);
  const column = int(start.column);
  const endLine = int(end.line);
  const endColumn = int(end.column);
  if (
    byteStart === null || byteEnd === null || line === null || column === null ||
    endLine === null || endColumn === null || byteEnd < byteStart
  ) {
    return null;
  }
  const match: AstGrepMatch = {
    file,
    line: line + 1,
    column: column + 1,
    endLine: endLine + 1,
    endColumn: endColumn + 1,
    text,
    lines: typeof item.lines === "string" ? item.lines : text,
    byteStart,
    byteEnd,
  };
  if (typeof item.replacement === "string") {
    match.replacement = item.replacement;
    const offsets = item.replacementOffsets;
    const rs = isRecord(offsets) ? int(offsets.start) : null;
    const re = isRecord(offsets) ? int(offsets.end) : null;
    match.replaceStart = rs !== null && re !== null && re >= rs ? rs : byteStart;
    match.replaceEnd = rs !== null && re !== null && re >= rs ? re : byteEnd;
  }
  return match;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
