import type { MotionTarget } from "./vim-motions.js";
import {
  clampNormal,
  firstNonBlank,
  lineCount,
  lineEnd,
  lineIndexOf,
  offsetOfLine,
} from "./vim-text.js";
import type { VimBuffer, VimOperator, VimRegister } from "./vim-types.js";

/**
 * Vim operators and puts (ATO-662): `d` / `c` / `y` over a range, the
 * linewise doubles (`dd` `cc` `yy`), `x`, and `p` / `P`. Each returns
 * the new buffer, what went into the register, and whether the command
 * leaves the editor in INSERT (`c`).
 */

export interface OperatorResult {
  readonly buffer: VimBuffer;
  readonly register: VimRegister | null;
  readonly insert: boolean;
}

export interface VimRange {
  readonly from: number;
  readonly to: number;
  readonly linewise: boolean;
}

/** The span a motion covers from `cursor`; `null` when it covers nothing. */
export function rangeOf(
  value: string,
  cursor: number,
  target: MotionTarget,
): VimRange | null {
  if (target.linewise) return linesRange(value, cursor, target.cursor);
  const from = Math.min(cursor, target.cursor);
  const to = Math.min(
    value.length,
    Math.max(cursor, target.cursor) + (target.inclusive ? 1 : 0),
  );
  return to > from ? { from, to, linewise: false } : null;
}

/** Whole lines from the line holding `a` to the line holding `b`. */
export function linesRange(value: string, a: number, b: number): VimRange {
  const rowA = lineIndexOf(value, Math.min(a, b));
  const rowB = lineIndexOf(value, Math.max(a, b));
  const from = offsetOfLine(value, rowA);
  const to = lineEnd(value, offsetOfLine(value, rowB));
  return { from, to, linewise: true };
}

/** `count` lines starting at the caret's (`dd`, `3yy`). */
export function countLinesRange(
  value: string,
  cursor: number,
  count: number,
): VimRange {
  const row = lineIndexOf(value, cursor);
  const last = Math.min(lineCount(value) - 1, row + Math.max(1, count) - 1);
  return linesRange(value, cursor, offsetOfLine(value, last));
}

export function applyOperator(
  buffer: VimBuffer,
  op: VimOperator,
  range: VimRange,
): OperatorResult {
  const { value, cursor } = buffer;
  const text = value.slice(range.from, range.to);
  const register: VimRegister = { text, linewise: range.linewise };
  if (op === "y") {
    const at = range.linewise ? cursor : range.from;
    return { buffer: { value, cursor: at }, register, insert: false };
  }
  if (op === "c") {
    // A linewise change keeps one (empty) line to type into.
    const next = value.slice(0, range.from) + value.slice(range.to);
    return { buffer: { value: next, cursor: range.from }, register, insert: true };
  }
  if (!range.linewise) {
    const next = value.slice(0, range.from) + value.slice(range.to);
    return {
      buffer: { value: next, cursor: clampNormal(next, range.from) },
      register,
      insert: false,
    };
  }
  return { buffer: deleteLines(value, range), register, insert: false };
}

/** Remove whole lines together with one of the newlines around them. */
function deleteLines(value: string, range: VimRange): VimBuffer {
  if (range.to < value.length) {
    const next = value.slice(0, range.from) + value.slice(range.to + 1);
    return { value: next, cursor: firstNonBlank(next, range.from) };
  }
  if (range.from > 0) {
    // The last lines went: the newline before them goes too, and the
    // caret lands on the line that is now last.
    const next = value.slice(0, range.from - 1);
    return { value: next, cursor: firstNonBlank(next, range.from - 1) };
  }
  return { value: "", cursor: 0 };
}

/** `x`: delete `count` characters under and after the caret, on its line. */
export function deleteChars(buffer: VimBuffer, count: number): OperatorResult | null {
  const { value, cursor } = buffer;
  const end = lineEnd(value, cursor);
  if (cursor >= end) return null;
  const to = Math.min(end, cursor + Math.max(1, count));
  return applyOperator(buffer, "d", { from: cursor, to, linewise: false });
}

/** `p` (after the caret / below the line) and `P` (before / above). */
export function put(
  buffer: VimBuffer,
  register: VimRegister,
  after: boolean,
  count: number,
): VimBuffer {
  const { value, cursor } = buffer;
  const n = Math.max(1, count);
  if (register.linewise) {
    const block = Array.from({ length: n }, () => register.text).join("\n");
    if (after) {
      const at = lineEnd(value, cursor);
      const next = `${value.slice(0, at)}\n${block}${value.slice(at)}`;
      return { value: next, cursor: firstNonBlank(next, at + 1) };
    }
    const at = offsetOfLine(value, lineIndexOf(value, cursor));
    const next = `${value.slice(0, at)}${block}\n${value.slice(at)}`;
    return { value: next, cursor: firstNonBlank(next, at) };
  }
  const text = register.text.repeat(n);
  if (text.length === 0) return buffer;
  const onChar = cursor < lineEnd(value, cursor);
  const at = after && onChar ? cursor + 1 : cursor;
  const next = value.slice(0, at) + text + value.slice(at);
  return { value: next, cursor: at + text.length - 1 };
}
