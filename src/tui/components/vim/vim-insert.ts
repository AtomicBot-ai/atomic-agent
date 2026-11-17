import { firstNonBlank, lineEnd, lineStart } from "./vim-text.js";
import { pushUndo, type VimBuffer, type VimState } from "./vim-types.js";

/**
 * Crossing between NORMAL and INSERT (ATO-662): `i a I A o O` and Esc.
 */

export type InsertEntry = "i" | "a" | "I" | "A" | "o" | "O";

export const INSERT_KEYS: ReadonlySet<string> = new Set([
  "i",
  "a",
  "I",
  "A",
  "o",
  "O",
]);

export interface ModeStep {
  readonly state: VimState;
  readonly buffer: VimBuffer;
}

/**
 * Enter INSERT. The buffer as it was is pushed for `u` first, so one
 * undo takes back the whole insert session (and the line `o` opened).
 */
export function enterInsert(
  state: VimState,
  buffer: VimBuffer,
  how: InsertEntry,
): ModeStep {
  const { value, cursor } = buffer;
  const next: VimState = { ...pushUndo(state, buffer), mode: "insert" };
  switch (how) {
    case "i":
      return { state: next, buffer };
    case "a":
      return {
        state: next,
        buffer: { value, cursor: Math.min(lineEnd(value, cursor), cursor + 1) },
      };
    case "I":
      return { state: next, buffer: { value, cursor: firstNonBlank(value, cursor) } };
    case "A":
      return { state: next, buffer: { value, cursor: lineEnd(value, cursor) } };
    case "o": {
      const at = lineEnd(value, cursor);
      return {
        state: next,
        buffer: { value: `${value.slice(0, at)}\n${value.slice(at)}`, cursor: at + 1 },
      };
    }
    case "O": {
      const at = lineStart(value, cursor);
      return {
        state: next,
        buffer: { value: `${value.slice(0, at)}\n${value.slice(at)}`, cursor: at },
      };
    }
  }
}

/**
 * Esc in INSERT: back to NORMAL with the caret one left, as vim does,
 * so it sits on the last character typed. An insert session that
 * changed nothing leaves no empty step on the undo stack.
 */
export function enterNormal(state: VimState, buffer: VimBuffer): ModeStep {
  const { value, cursor } = buffer;
  const top = state.undo[state.undo.length - 1];
  const undo =
    top !== undefined && top.value === value ? state.undo.slice(0, -1) : state.undo;
  const at = cursor > lineStart(value, cursor) ? cursor - 1 : cursor;
  return {
    state: {
      ...state,
      mode: "normal",
      undo,
      count: "",
      operator: null,
      operatorCount: "",
      pendingG: false,
    },
    buffer: { value, cursor: at },
  };
}
