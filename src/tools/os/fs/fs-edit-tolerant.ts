/**
 * The tolerant match chain `os.fs.edit` walks when `oldString` is not in
 * the file exactly (ATO-692).
 *
 * Small local models copy text with the wrong indentation, a collapsed
 * run of spaces, `\"` where the file has `"`, or a straight quote where
 * the file has a curly one, and get "oldString not found" until the loop
 * detector ends the turn. Each level below forgives one more kind of
 * drift, strictest first. The rules that keep it safe:
 *
 *  - the exact match is always tried first, by the caller;
 *  - a level applies only when it finds exactly ONE span in the file;
 *  - an ambiguous level stops the chain: a looser reading of text that
 *    already fits two places would only be a guess;
 *  - a span far larger than `oldString` is refused;
 *  - the replaced region is the file's own text, and `newString` goes in
 *    as sent with three exceptions: its line endings follow the file; on
 *    `boundary` the whitespace trimmed from `oldString` is trimmed from
 *    `newString` too; on `indentation` its lines take the same shift.
 *
 * The levels follow opencode's edit replacers (MIT) and, for typography,
 * the punctuation folding in Codex's `seek_sequence` (Apache-2.0); see
 * THIRD-PARTY-NOTICES.md. Left out on purpose: opencode's
 * `ContextAwareReplacer` (accepts half the middle lines differing) and
 * `MultiOccurrenceReplacer` (exists to feed replaceAll).
 */

import { findBlockAnchorMatch } from "./fs-edit-block-anchor.js";
import { findTypographic, findUnescaped } from "./fs-edit-folding.js";
import {
  countSpans,
  findLineBlockMatch,
  matchLineEndings,
  occurrences,
  type LooseEditLookup,
  type LooseEditMatch,
} from "./fs-edit-match.js";

export type EditMatchLevel =
  | "whitespace"
  | "boundary"
  | "indentation"
  | "line-trim"
  | "inner-whitespace"
  | "escapes"
  | "typography"
  | "block-anchor";

/** A tolerant match the edit can apply. */
export interface TolerantEdit {
  kind: "unique";
  level: EditMatchLevel;
  match: LooseEditMatch;
  /** `newString` as it goes into the span. */
  replacement: string;
  /** `newString`'s lines were shifted to the file's indentation. */
  reindented: boolean;
}

export type TolerantEditLookup =
  | TolerantEdit
  | { kind: "ambiguous"; level: EditMatchLevel; count: number }
  | { kind: "none" };

interface Level {
  id: EditMatchLevel;
  /** Completes "it matched one place once …". */
  relaxation: string;
  find(source: string, oldString: string): LooseEditLookup;
}

const LEVELS: readonly Level[] = [
  {
    id: "whitespace",
    relaxation: "blank lines and trailing spaces were ignored",
    find: (source, oldString) => findLineBlockMatch(source, oldString),
  },
  {
    id: "boundary",
    relaxation: "its leading and trailing whitespace was trimmed",
    find: findTrimmedBoundary,
  },
  {
    id: "indentation",
    relaxation: "its overall indentation was ignored (the lines' indentation relative to each other still matched)",
    find: (source, oldString) =>
      findLineBlockMatch(source, oldString, (line) => line.trimStart(), sameRelativeIndent),
  },
  {
    id: "line-trim",
    relaxation: "each line's leading and trailing whitespace was ignored",
    find: (source, oldString) =>
      findLineBlockMatch(source, oldString, (line) => line.trimStart()),
  },
  {
    id: "inner-whitespace",
    relaxation: "every run of whitespace was treated as one space",
    find: findCollapsedWhitespace,
  },
  {
    id: "escapes",
    relaxation: "backslash escapes such as \\n, \\t and \\\" were read as the characters they stand for",
    find: findUnescaped,
  },
  {
    id: "typography",
    relaxation: "curly quotes, typographic dashes and non-breaking spaces were read as their plain ASCII forms",
    find: findTypographic,
  },
  {
    id: "block-anchor",
    relaxation: "its first and last lines matched and the lines between them were similar but not identical",
    find: findBlockAnchorMatch,
  },
];

const CHECK_INDENT = " newString was inserted as sent, so check its indentation against the file's.";

/** What a level may have let through that `newString` repeats. */
const CAUTION: Partial<Record<EditMatchLevel, string>> = {
  indentation: CHECK_INDENT,
  "line-trim": CHECK_INDENT,
  "inner-whitespace": CHECK_INDENT,
  escapes: " newString was inserted as sent, so check its backslash escapes.",
  "block-anchor": " The whole block was replaced, including the lines that differed.",
};

/**
 * Walk the chain for an `oldString` with no exact occurrence. The first
 * level that finds anything decides: one span is applied, several are
 * refused, and `none` means no level found any.
 */
export function findTolerantEditMatch(
  source: string,
  oldString: string,
  newString: string,
): TolerantEditLookup {
  for (const level of LEVELS) {
    const lookup = level.find(source, oldString);
    if (lookup.kind === "none") continue;
    if (lookup.kind === "ambiguous") {
      return { kind: "ambiguous", level: level.id, count: lookup.count };
    }
    const { start, end } = lookup.match;
    const replaced = source.slice(start, end);
    if (isDisproportionate(replaced, oldString)) return { kind: "none" };
    const shifted = level.id === "indentation" ? reindent(newString, oldString, replaced) : null;
    const sent =
      level.id === "boundary" ? trimLikeOldString(newString, oldString) : (shifted ?? newString);
    return {
      kind: "unique",
      level: level.id,
      match: lookup.match,
      replacement: matchLineEndings(sent, replaced),
      reindented: shifted !== null,
    };
  }
  return { kind: "none" };
}

const REINDENTED = " newString's lines were shifted by the same indentation, in the file's whitespace.";

/** First line of a result whose edit landed on a tolerant match. */
export function tolerantMatchNote(level: EditMatchLevel, reindented = false): string {
  const caution = reindented ? REINDENTED : (CAUTION[level] ?? "");
  return `note: oldString was not found exactly; it matched one place once ${relaxationOf(level)}, and the edit was applied there.${caution} Check the diff.`;
}

/** The shortest indentation among `text`'s non-blank lines (the first, on a tie). */
function commonIndent(text: string): string {
  let common: string | null = null;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const indent = leadingWhitespace(line);
    if (common === null || indent.length < common.length) common = indent;
  }
  return common ?? "";
}

/**
 * On the `indentation` level the block matched shifted as a whole, so
 * `newString` is shifted the same way: `oldString`'s common indentation
 * is swapped for the file's on every non-blank line. `null` (insert as
 * sent) when a line of `newString` lacks that indentation to swap.
 */
function reindent(newString: string, oldString: string, replaced: string): string | null {
  const theirs = commonIndent(replaced);
  const ours = commonIndent(oldString);
  if (theirs === ours) return null;
  const lines = newString.split("\n");
  const blank = (line: string) => line.trim().length === 0;
  if (!lines.every((line) => blank(line) || line.startsWith(ours))) return null;
  return lines.map((line) => (blank(line) ? line : theirs + line.slice(ours.length))).join("\n");
}

/** The error for a level that fit more than one place. */
export function tolerantAmbiguityMessage(level: EditMatchLevel, count: number): string {
  return `os.fs.edit: \`oldString\` was not found exactly, and once ${relaxationOf(level)} it matches ${count} places, so nothing was changed. Include more surrounding lines, copied exactly from the file.`;
}

function relaxationOf(level: EditMatchLevel): string {
  return LEVELS.find((candidate) => candidate.id === level)!.relaxation;
}

/**
 * A match many lines longer, or many times longer, than `oldString` is
 * not what the model meant, however it was reached.
 */
function isDisproportionate(replaced: string, oldString: string): boolean {
  const oldLines = oldString.split("\n").length;
  const spanLines = replaced.split("\n").length;
  if (spanLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  const oldLength = oldString.trim().length;
  return oldLines > 1 && replaced.trim().length > Math.max(oldLength + 500, oldLength * 4);
}

function leadingWhitespace(text: string): string {
  return text.slice(0, text.length - text.trimStart().length);
}

function trailingWhitespace(text: string): string {
  return text.slice(text.trimEnd().length);
}

/**
 * Where `oldString` starts or ends with whitespace, a match of its
 * trimmed text must still sit next to whitespace or the file's edge, so
 * `  x = 1` cannot land inside `yx = 1`.
 */
function keepsEdges(source: string, oldString: string): (start: number, end: number) => boolean {
  const lead = leadingWhitespace(oldString).length > 0;
  const trail = trailingWhitespace(oldString).length > 0;
  const edge = (at: number) => at < 0 || at >= source.length || /\s/.test(source[at]!);
  return (start, end) => (!lead || edge(start - 1)) && (!trail || edge(end));
}

/** `oldString` without its leading and trailing whitespace. */
function findTrimmedBoundary(source: string, oldString: string): LooseEditLookup {
  const core = oldString.trim();
  if (core === oldString || core.length === 0) return { kind: "none" };
  return countSpans(occurrences(source, core, keepsEdges(source, oldString)));
}

/** `newString` less the whitespace the boundary level trimmed from `oldString`. */
function trimLikeOldString(newString: string, oldString: string): string {
  const lead = leadingWhitespace(oldString);
  const trail = trailingWhitespace(oldString);
  if (newString.length < lead.length + trail.length) return newString;
  let result = newString;
  if (lead.length > 0 && result.startsWith(lead)) result = result.slice(lead.length);
  if (trail.length > 0 && result.endsWith(trail)) result = result.slice(0, result.length - trail.length);
  return result;
}

/** The window's lines, with their common indentation removed, keep `needle`'s shape. */
function sameRelativeIndent(hay: readonly string[], start: number, needle: readonly string[]): boolean {
  const window = hay.slice(start, start + needle.length);
  const dedent = (lines: readonly string[]) => {
    const indents = lines.map(leadingWhitespace);
    const common = Math.min(...indents.map((indent) => indent.length));
    return indents.map((indent) => indent.slice(common));
  };
  const theirs = dedent(window);
  const ours = dedent(needle);
  return theirs.every((indent, j) => indent === ours[j]);
}

/** `oldString`'s words in order, any run of whitespace between them. */
function findCollapsedWhitespace(source: string, oldString: string): LooseEditLookup {
  const words = oldString.trim().split(/\s+/);
  if (words.length < 2) return { kind: "none" };
  const pattern = new RegExp(words.map(escapeRegExp).join("\\s+"), "g");
  const keep = keepsEdges(source, oldString);
  const spans: LooseEditMatch[] = [];
  for (let hit = pattern.exec(source); hit !== null && spans.length < 2; hit = pattern.exec(source)) {
    const end = hit.index + hit[0]!.length;
    if (keep(hit.index, end)) spans.push({ start: hit.index, end });
  }
  return countSpans(spans);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
