import type { Key } from "ink";
import { cursorToRowCol, rowColToCursor } from "./multi-line-editor-cursor.js";
import { normalizeInsertText } from "./multi-line-editor-input.js";

/**
 * The slice of the editor's key context that buffer edits need. A
 * structural subset of `KeyContext` (multi-line-editor-keys.ts) so these
 * helpers can live in their own file without a circular import.
 */
export interface EditContext {
  key: Key;
  value: string;
  cursor: number;
  setBuffer: (next: string, cursor: number) => void;
  /** Selected span in buffer offsets, or `null`. */
  selection: readonly [number, number] | null;
  /** Where the selection was started; `null` means none is active. */
  anchor: number | null;
  setAnchor: (anchor: number | null) => void;
}

export function insertText(ctx: EditContext, text: string): void {
  const { value, cursor, setBuffer, selection } = ctx;
  const clean = normalizeInsertText(text);
  if (clean.length === 0) return;
  // Typing over a selection replaces it, which is what every editor
  // does and what makes select-then-retype work.
  if (selection) {
    const [from, to] = selection;
    ctx.setAnchor(null);
    const next = value.slice(0, from) + clean + value.slice(to);
    setBuffer(next, from + clean.length);
    return;
  }
  const next = value.slice(0, cursor) + clean + value.slice(cursor);
  setBuffer(next, cursor + clean.length);
}

/** Remove the selected span and put the caret where it started. */
export function deleteSelection(ctx: EditContext): void {
  const { value, setBuffer, selection } = ctx;
  if (!selection) return;
  const [from, to] = selection;
  ctx.setAnchor(null);
  setBuffer(value.slice(0, from) + value.slice(to), from);
}

/**
 * Called before every caret move. Shift keeps (or drops) an anchor so
 * the move extends a selection; an unshifted move collapses it. Holding
 * the anchor rather than a range is what lets one rule cover every
 * movement key.
 */
export function updateAnchorForMove(ctx: EditContext): void {
  if (ctx.key.shift) {
    if (ctx.anchor === null) ctx.setAnchor(ctx.cursor);
    return;
  }
  if (ctx.anchor !== null) ctx.setAnchor(null);
}

export function moveCursorVertically(
  ctx: EditContext,
  direction: -1 | 1,
): void {
  const { value, cursor, setBuffer } = ctx;
  const { row, col } = cursorToRowCol(value, cursor);
  const lines = value.split("\n");
  const nextRow = row + direction;
  if (nextRow < 0 || nextRow >= lines.length) return;
  const nextLine = lines[nextRow] ?? "";
  const nextCol = Math.min(col, nextLine.length);
  const nextOffset = rowColToCursor(lines, nextRow, nextCol);
  setBuffer(value, nextOffset);
}
