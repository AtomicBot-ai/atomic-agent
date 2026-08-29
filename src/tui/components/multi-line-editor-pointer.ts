import { rowColToCursor } from "./multi-line-editor-cursor.js";

/**
 * Mouse handling for the editor: click-to-place-caret and drag-to-select.
 * Split from `multi-line-editor.tsx` purely to keep that file inside the
 * size budget — these are the component's own handlers, built fresh each
 * render over its live state setters.
 */
export interface EditorPointerDeps {
  readonly value: string;
  readonly cursorPos: number;
  readonly disabled: boolean;
  readonly setCursorPos: (pos: number) => void;
  /** Functional form required: `endDrag` folds over the current anchor. */
  readonly setAnchor: (
    update: number | null | ((current: number | null) => number | null),
  ) => void;
  readonly onClickFocus?: () => void;
}

export interface EditorPointerHandlers {
  readonly placeCursorAt: (row: number, col: number) => void;
  readonly beginDrag: (row: number, col: number) => void;
  readonly extendDrag: (row: number, col: number) => void;
  readonly endDrag: () => void;
}

export function createEditorPointer(
  deps: EditorPointerDeps,
): EditorPointerHandlers {
  const { value, cursorPos, disabled, setCursorPos, setAnchor, onClickFocus } =
    deps;

  /**
   * Buffer offset for a clicked cell, clamped to the line.
   * `rowColToCursor` does not clamp, so a click past the end of a short
   * line would otherwise run the offset into the following line;
   * clamping here keeps a click in the empty space to the right of a
   * line meaning "end of this line", which is what every editor does.
   */
  const offsetAt = (row: number, col: number): number => {
    const lines = value.split("\n");
    const safeRow = Math.max(0, Math.min(row, lines.length - 1));
    const safeCol = Math.max(0, Math.min(col, (lines[safeRow] ?? "").length));
    return rowColToCursor(lines, safeRow, safeCol);
  };

  /**
   * Press: drop the anchor and take the pointer. Capture matters because
   * hit-testing routes by position — without it, a drag that wanders out
   * of the composer would deliver its motion, and its release, to
   * whatever sits under the cursor, and the selection would neither
   * extend nor end.
   */
  const beginDrag = (row: number, col: number): void => {
    if (disabled) return;
    setAnchor(offsetAt(row, col));
  };

  const extendDrag = (row: number, col: number): void => {
    if (disabled) return;
    setCursorPos(offsetAt(row, col));
  };

  const endDrag = (): void => {
    // A drag that never moved is a click, not a selection.
    setAnchor((current) =>
      current === null || current === cursorPos ? null : current,
    );
  };

  const placeCursorAt = (row: number, col: number): void => {
    if (disabled) return;
    // Ask for focus first: a click that moves a caret the operator
    // cannot then type into is a click that did nothing.
    onClickFocus?.();
    // A fresh press collapses whatever was selected — `beginDrag` sets
    // the new anchor immediately afterwards.
    setAnchor(null);
    setCursorPos(offsetAt(row, col));
  };

  return { placeCursorAt, beginDrag, extendDrag, endDrag };
}
