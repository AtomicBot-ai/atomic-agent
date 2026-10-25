/**
 * Locating `oldString` for `os.fs.edit` when the exact substring is not
 * in the file (ATO-785).
 *
 * Small models copy a block and drop what they cannot see: the blank
 * line between an import and a loop, a trailing space, a `\r`. The exact
 * search then fails, the model re-reads the file and sends the same
 * edit again, and five identical retries later the loop detector stops
 * the turn. Two answers, in order:
 *
 *  1. A whitespace-tolerant match. The file and `oldString` are compared
 *     line by line with blank lines skipped and trailing whitespace
 *     (including `\r`) ignored. Leading indentation still has to match,
 *     since it carries meaning in Python and YAML. Only whole lines
 *     match. The edit is applied only when exactly ONE span matches; an
 *     ambiguous match is never applied. This is the first and strictest
 *     level of the chain in `fs-edit-tolerant.ts` (ATO-692), which tries
 *     looser ones only when this one finds nothing.
 *  2. Otherwise, the nearest fragment of the file: the lines that share
 *     the most lines with `oldString`, quoted as a JSON string so the
 *     model sees the real line breaks it has to copy.
 */

/** Where a whitespace-tolerant match sits in the original text. */
export interface LooseEditMatch {
  /** Offset of the first character the edit replaces. */
  start: number;
  /** Offset just past the last character the edit replaces. */
  end: number;
}

export type LooseEditLookup =
  | { kind: "unique"; match: LooseEditMatch }
  | { kind: "ambiguous"; count: number }
  | { kind: "none" };

/** Longest nearest-fragment quote the not-found error carries, in characters of JSON. */
export const NEAREST_FRAGMENT_MAX_CHARS = 160;

export interface FileLine {
  /** Offset of the line's first character. */
  start: number;
  /** Offset just past the line's last character, before its `\n`. */
  end: number;
  /** The line with trailing whitespace removed. */
  text: string;
}

export function splitLines(text: string): FileLine[] {
  const lines: FileLine[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    lines.push({ start, end, text: text.slice(start, end).trimEnd() });
    if (newline === -1) return lines;
    start = newline + 1;
  }
}

function contentLines(lines: readonly FileLine[]): FileLine[] {
  return lines.filter((line) => line.text.length > 0);
}

/**
 * Find `oldString` in `source` ignoring blank lines and trailing
 * whitespace. `none` when `oldString` has no non-blank line, or when
 * nothing matches.
 */
export function findLooseEditMatch(
  source: string,
  oldString: string,
): LooseEditLookup {
  return findLineBlockMatch(source, oldString);
}

/**
 * The line matcher behind `findLooseEditMatch`, shared with the more
 * tolerant levels in `fs-edit-tolerant.ts`. Blank lines are skipped on
 * both sides and trailing whitespace never counts; each remaining line
 * is compared through `key` (identity by default), and a window whose
 * keys all agree is kept only if `accept` (when given) agrees too.
 */
export function findLineBlockMatch(
  source: string,
  oldString: string,
  key: (line: string) => string = (line) => line,
  accept?: (hay: readonly string[], start: number, needle: readonly string[]) => boolean,
): LooseEditLookup {
  const needleText = contentLines(splitLines(oldString)).map((line) => line.text);
  if (needleText.length === 0) return { kind: "none" };
  const needle = needleText.map(key);
  const hay = contentLines(splitLines(source));
  const hayText = hay.map((line) => line.text);
  const hayKeys = hayText.map(key);
  const hits: number[] = [];
  for (let i = 0; i + needle.length <= hay.length; i += 1) {
    let same = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (hayKeys[i + j] !== needle[j]) {
        same = false;
        break;
      }
    }
    if (same && (accept === undefined || accept(hayText, i, needleText))) {
      hits.push(i);
    }
  }
  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) return { kind: "ambiguous", count: hits.length };
  const first = hay[hits[0]!]!;
  const last = hay[hits[0]! + needle.length - 1]!;
  return { kind: "unique", match: lineSpan(source, oldString, first, last) };
}

/**
 * The span from `first`'s start to `last`'s content. Its own trailing
 * whitespace stays unless `oldString` ends a line: a leading or trailing
 * newline in `oldString` takes the neighbouring newline with it, as the
 * exact match would have.
 */
export function lineSpan(
  source: string,
  oldString: string,
  first: FileLine,
  last: FileLine,
): LooseEditMatch {
  let start = first.start;
  let end = last.start + last.text.length;
  if (oldString.startsWith("\n") && start > 0) {
    start -= source.slice(start - 2, start) === "\r\n" ? 2 : 1;
  }
  if (/\n$/.test(oldString)) {
    const lineEnd = last.end;
    end = source[lineEnd] === "\n" ? lineEnd + 1 : lineEnd;
  }
  return { start, end };
}

/** A list of spans as a lookup: one is unique, more are ambiguous. */
export function countSpans(spans: readonly LooseEditMatch[]): LooseEditLookup {
  if (spans.length === 0) return { kind: "none" };
  if (spans.length > 1) return { kind: "ambiguous", count: spans.length };
  return { kind: "unique", match: spans[0]! };
}

/** Every non-overlapping occurrence of `needle`, kept when `keep` agrees. */
export function occurrences(
  haystack: string,
  needle: string,
  keep: (start: number, end: number) => boolean = () => true,
): LooseEditMatch[] {
  const spans: LooseEditMatch[] = [];
  if (needle.length === 0) return spans;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    if (keep(at, at + needle.length)) spans.push({ start: at, end: at + needle.length });
  }
  return spans;
}

/**
 * `newString` with the line endings of the text it replaces. A loose
 * match is how a CRLF file meets an LF `oldString` at all, and the
 * model's `newString` is LF too: spliced in as sent, it would leave the
 * edited lines LF in a CRLF file. When the replaced span uses `\r\n`,
 * every bare `\n` in `newString` becomes `\r\n`; otherwise it is
 * returned unchanged.
 */
export function matchLineEndings(newString: string, replaced: string): string {
  if (!replaced.includes("\r\n")) return newString;
  return newString.replace(/\r?\n/g, "\r\n");
}

/**
 * The run of file lines that shares the most trimmed lines with
 * `oldString`, as an exact JSON-quoted slice of the file, clipped to
 * `NEAREST_FRAGMENT_MAX_CHARS`. `null` when no line is shared.
 */
export function nearestFragment(
  source: string,
  oldString: string,
): string | null {
  const wanted = new Set(
    contentLines(splitLines(oldString)).map((line) => line.text.trim()),
  );
  if (wanted.size === 0) return null;
  const lines = splitLines(source);
  const span = Math.max(1, splitLines(oldString).length);
  let best = { score: 0, from: 0 };
  for (let i = 0; i < lines.length; i += 1) {
    // A window starts on a shared line, so the quote opens where the
    // model's text does rather than on a blank line above it.
    if (lines[i]!.text.length === 0 || !wanted.has(lines[i]!.text.trim())) {
      continue;
    }
    let score = 0;
    for (let j = i; j < Math.min(lines.length, i + span); j += 1) {
      if (wanted.has(lines[j]!.text.trim()) && lines[j]!.text.length > 0) {
        score += 1;
      }
    }
    if (score > best.score) best = { score, from: i };
  }
  if (best.score === 0) return null;
  const to = Math.min(lines.length, best.from + span) - 1;
  const fragment = source.slice(lines[best.from]!.start, lines[to]!.end);
  const quoted = JSON.stringify(fragment);
  return quoted.length > NEAREST_FRAGMENT_MAX_CHARS
    ? `${quoted.slice(0, NEAREST_FRAGMENT_MAX_CHARS)}…`
    : quoted;
}
