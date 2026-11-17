import {
  firstNonBlank,
  lineCount,
  lineEnd,
  lineIndexOf,
  lineStart,
  nextWordStart,
  offsetOfLine,
  prevWordStart,
  wordEnd,
} from "./vim-text.js";

/**
 * Vim motions (ATO-662). A motion answers "where does the caret go",
 * plus the two facts an operator needs to turn that into a range:
 * whether it covers whole lines (`j`, `gg`) and whether the target
 * character itself is included (`e`).
 */

export type VimMotion =
  | "h"
  | "l"
  | "j"
  | "k"
  | "w"
  | "b"
  | "e"
  | "0"
  | "$"
  | "^"
  | "gg"
  | "G";

export const MOTION_KEYS: ReadonlySet<string> = new Set([
  "h",
  "l",
  "j",
  "k",
  "w",
  "b",
  "e",
  "0",
  "$",
  "^",
  "G",
]);

export interface MotionTarget {
  readonly cursor: number;
  readonly linewise: boolean;
  readonly inclusive: boolean;
}

/**
 * Resolve `motion` from `cursor`, repeated `count` times. `hasCount`
 * matters only to `gg` / `G`, where a count names a line instead of
 * repeating. Returns `null` when the motion cannot move at all (`j` on
 * the last line), which makes an operator over it a no-op, as in vim.
 */
export function resolveMotion(
  value: string,
  cursor: number,
  motion: VimMotion,
  count: number,
  hasCount: boolean,
): MotionTarget | null {
  const n = Math.max(1, count);
  switch (motion) {
    case "h":
      return charwise(Math.max(lineStart(value, cursor), cursor - n));
    case "l":
      return charwise(Math.min(lineEnd(value, cursor), cursor + n));
    case "j":
    case "k":
      return vertical(value, cursor, motion === "j" ? n : -n);
    case "w":
      return charwise(repeat(n, cursor, (at) => nextWordStart(value, at)));
    case "b":
      return charwise(repeat(n, cursor, (at) => prevWordStart(value, at)));
    case "e":
      return {
        cursor: repeat(n, cursor, (at) => wordEnd(value, at)),
        linewise: false,
        inclusive: true,
      };
    case "0":
      return charwise(lineStart(value, cursor));
    case "^":
      return charwise(firstNonBlank(value, cursor));
    case "$": {
      // `3$` is the end of the line two below, as in vim.
      const row = Math.min(
        lineIndexOf(value, cursor) + n - 1,
        lineCount(value) - 1,
      );
      return charwise(lineEnd(value, offsetOfLine(value, row)));
    }
    case "gg":
    case "G": {
      const last = lineCount(value) - 1;
      const row = hasCount
        ? Math.min(Math.max(1, count), last + 1) - 1
        : motion === "gg"
          ? 0
          : last;
      return {
        cursor: firstNonBlank(value, offsetOfLine(value, row)),
        linewise: true,
        inclusive: false,
      };
    }
  }
}

function charwise(cursor: number): MotionTarget {
  return { cursor, linewise: false, inclusive: false };
}

function repeat(n: number, from: number, step: (at: number) => number): number {
  let at = from;
  for (let i = 0; i < n; i += 1) {
    const next = step(at);
    if (next === at) break;
    at = next;
  }
  return at;
}

/** `j` / `k`: same column on the target line, clamped to its length. */
function vertical(
  value: string,
  cursor: number,
  delta: number,
): MotionTarget | null {
  const row = lineIndexOf(value, cursor);
  const target = Math.max(0, Math.min(lineCount(value) - 1, row + delta));
  if (target === row) return null;
  const col = cursor - lineStart(value, cursor);
  const start = offsetOfLine(value, target);
  const end = lineEnd(value, start);
  return {
    cursor: Math.min(start + col, end),
    linewise: true,
    inclusive: false,
  };
}
