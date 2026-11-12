import { lineEnd, lineStart } from "../multi-line-editor-cursor.js";

/**
 * Text geometry for the vim grammar (ATO-662): lines, words and the
 * NORMAL-mode caret rule. Pure functions over `(value, offset)`; the
 * line helpers reuse the editor's own so both layers agree on what a
 * line is.
 */

export { lineEnd, lineStart };

/** 0 = blank (space, tab, newline), 1 = keyword char, 2 = other punctuation. */
export function charClass(ch: string | undefined): 0 | 1 | 2 {
  if (ch === undefined || /\s/.test(ch)) return 0;
  if (/[\p{L}\p{N}_]/u.test(ch)) return 1;
  return 2;
}

/** First non-blank character of the caret's line (or its end, if blank). */
export function firstNonBlank(value: string, cursor: number): number {
  const end = lineEnd(value, cursor);
  let i = lineStart(value, cursor);
  while (i < end && (value[i] === " " || value[i] === "\t")) i += 1;
  return i;
}

/**
 * NORMAL mode keeps the caret ON a character, never past the end of a
 * non-empty line — the block cursor vim users expect. An empty line (or
 * an empty buffer) has only one place for it.
 */
export function clampNormal(value: string, cursor: number): number {
  const at = Math.max(0, Math.min(cursor, value.length));
  const start = lineStart(value, at);
  const end = lineEnd(value, at);
  if (end > start && at >= end) return end - 1;
  return at;
}

/** Zero-based line index of `cursor` and the number of lines in `value`. */
export function lineIndexOf(value: string, cursor: number): number {
  let row = 0;
  const upTo = Math.min(cursor, value.length);
  for (let i = 0; i < upTo; i += 1) if (value[i] === "\n") row += 1;
  return row;
}

export function lineCount(value: string): number {
  let rows = 1;
  for (const ch of value) if (ch === "\n") rows += 1;
  return rows;
}

/** Offset of the start of line `row` (clamped to the buffer's lines). */
export function offsetOfLine(value: string, row: number): number {
  let offset = 0;
  for (let r = 0; r < row; r += 1) {
    const nl = value.indexOf("\n", offset);
    if (nl === -1) return offset;
    offset = nl + 1;
  }
  return offset;
}

/** `w`: start of the next word, or the buffer's end. */
export function nextWordStart(value: string, from: number): number {
  const n = value.length;
  let i = from;
  if (i >= n) return n;
  const cls = charClass(value[i]);
  if (cls !== 0) while (i < n && charClass(value[i]) === cls) i += 1;
  while (i < n && charClass(value[i]) === 0) i += 1;
  return i;
}

/** `b`: start of the current word if inside one, else of the previous. */
export function prevWordStart(value: string, from: number): number {
  let i = Math.min(from, value.length) - 1;
  if (i <= 0) return 0;
  while (i > 0 && charClass(value[i]) === 0) i -= 1;
  const cls = charClass(value[i]);
  if (cls === 0) return i;
  while (i > 0 && charClass(value[i - 1]) === cls) i -= 1;
  return i;
}

/** `e`: last character of the current word if not on it, else of the next. */
export function wordEnd(value: string, from: number): number {
  const n = value.length;
  if (n === 0) return 0;
  let i = from + 1;
  while (i < n && charClass(value[i]) === 0) i += 1;
  if (i >= n) return n - 1;
  const cls = charClass(value[i]);
  while (i + 1 < n && charClass(value[i + 1]) === cls) i += 1;
  return i;
}
