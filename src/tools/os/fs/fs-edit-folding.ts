/**
 * Two levels of the `os.fs.edit` match chain (ATO-692) that fold
 * characters before comparing, rather than whitespace.
 *
 *  - Escapes: `oldString` written with `\n` or `\"` where the file has
 *    the characters themselves (or the other way round), the way a model
 *    copies text out of a JSON tool call. After opencode's
 *    `EscapeNormalizedReplacer` (MIT).
 *  - Typography: curly quotes, typographic dashes and odd spaces read as
 *    their ASCII forms, so a straight-quoted `oldString` meets a file
 *    written in a word processor. After the punctuation folding in
 *    Codex's `seek_sequence` (Apache-2.0).
 *
 * See THIRD-PARTY-NOTICES.md. Both are applied only to a unique span,
 * by the chain in `fs-edit-tolerant.ts`.
 */

import {
  countSpans,
  findLineBlockMatch,
  occurrences,
  splitLines,
  type LooseEditLookup,
  type LooseEditMatch,
} from "./fs-edit-match.js";

const ESCAPE = /\\(\r?\n|[ntr'"`\\$])/g;

/** Text with `\n`, `\t`, `\r`, `\'`, `\"`, `` \` ``, `\\`, `\$` and line continuations resolved. */
export function unescapeText(text: string): string {
  return text.replace(ESCAPE, (_match: string, char: string) =>
    char === "n" || char.endsWith("\n")
      ? "\n"
      : char === "t"
        ? "\t"
        : char === "r"
          ? "\r"
          : char,
  );
}

/**
 * Escapes on either side: `oldString`'s escapes resolved and found as
 * is, or a run of whole file lines holding escapes that resolve to
 * `oldString`'s text.
 */
export function findUnescaped(source: string, oldString: string): LooseEditLookup {
  const plain = unescapeText(oldString);
  if (plain !== oldString) {
    const direct = occurrences(source, plain);
    if (direct.length === 0 && source.includes("\r\n")) {
      direct.push(...occurrences(source, plain.replace(/\r?\n/g, "\r\n")));
    }
    if (direct.length > 0) return countSpans(direct);
  }
  if (!source.includes("\\")) return { kind: "none" };
  return countSpans(escapedLineRuns(source, plain));
}

/**
 * Runs of file lines that resolve to `plain`. A file escape such as
 * `\n` resolves to a line break, so a run may have fewer lines than
 * `plain`: every length up to `plain`'s is tried. A trailing newline in
 * `plain` takes the run's own newline, as the exact match would have.
 */
function escapedLineRuns(source: string, plain: string): LooseEditMatch[] {
  const body = plain.endsWith("\n") ? plain.slice(0, -1) : plain;
  const lines = splitLines(source);
  const most = body.split("\n").length;
  const spans: LooseEditMatch[] = [];
  for (let i = 0; i < lines.length && spans.length < 2; i += 1) {
    // A run's first line resolves on its own to the start of `body`
    // (unless it ends in a backslash, which escapes the line break).
    const first = source.slice(lines[i]!.start, lines[i]!.end).replace(/\r$/, "");
    if (!first.endsWith("\\") && !body.startsWith(unescapeText(first))) continue;
    for (let size = 1; size <= most && i + size <= lines.length; size += 1) {
      const start = lines[i]!.start;
      const lineEnd = lines[i + size - 1]!.end;
      // An escape is two characters for one, so a run that resolves to
      // `body` spans between body.length and twice that (plus a `\r` a
      // line). Bounding by length keeps a failed edit of a large file
      // linear instead of slicing every run up to `most` lines.
      const span = lineEnd - start;
      if (span > 2 * body.length + size) break;
      if (span < body.length) continue;
      const block = source.slice(start, lineEnd).replace(/\r$/gm, "");
      if (!block.includes("\\") || unescapeText(block) !== body) continue;
      const end =
        body === plain
          ? lineEnd - (source[lineEnd - 1] === "\r" ? 1 : 0)
          : Math.min(source.length, lineEnd + 1);
      spans.push({ start, end });
      break;
    }
  }
  return spans;
}

const TYPOGRAPHIC = /[‐-―−‘-‟  -   　]/g;

/**
 * Curly quotes, typographic dashes and odd spaces as ASCII. One UTF-16
 * unit always becomes one, so offsets in the folded text are offsets in
 * the original.
 */
export function foldTypography(text: string): string {
  return text.replace(TYPOGRAPHIC, (char) => {
    const code = char.charCodeAt(0);
    if ((code >= 0x2010 && code <= 0x2015) || code === 0x2212) return "-";
    if (code >= 0x2018 && code <= 0x201b) return "'";
    if (code >= 0x201c && code <= 0x201f) return '"';
    return " ";
  });
}

/**
 * Typography folded on both sides: first as a plain substring, then as
 * whole lines with indentation and trailing whitespace ignored.
 */
export function findTypographic(source: string, oldString: string): LooseEditLookup {
  const folded = foldTypography(source);
  const needle = foldTypography(oldString);
  if (folded === source && needle === oldString) return { kind: "none" };
  const direct = countSpans(occurrences(folded, needle));
  if (direct.kind !== "none") return direct;
  return findLineBlockMatch(source, oldString, (line) => foldTypography(line.trimStart()));
}
