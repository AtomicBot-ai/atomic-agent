import { Box, Text } from "ink";
import { useRef, type ReactElement } from "react";
import { useMouseCommands, useMouseTarget } from "../mouse/mouse-context.js";
import { isPrimaryPress, isSecondaryPress } from "../mouse/mouse-event.js";
import { computeRowWindow } from "../row-window.js";
import { theme } from "../theme/theme.js";
import type { Cursor } from "./multi-line-editor-cursor.js";

/** Width of the `❯ ` / `  ` gutter in front of every editor line. */
const GUTTER_COLUMNS = 2;

export interface EditorBodyProps {
  value: string;
  cursor: Cursor;
  placeholder: string;
  focus: boolean;
  /**
   * Selected span as buffer offsets, `[start, end)`, or `null`. Painted
   * in inverse video — the same mark the caret uses, because a terminal
   * has exactly one way to say "this text is picked out" and no colour
   * that survives every palette.
   */
  selection?: readonly [number, number] | null;
  /** Buffer offset of the first character of each rendered line. */
  onDragStart?: (row: number, col: number) => void;
  onDragMove?: (row: number, col: number) => void;
  onDragEnd?: () => void;
  /**
   * Move the caret to a clicked cell. `row`/`col` are already relative
   * to the text, gutter excluded; the owner clamps and converts them to
   * a buffer offset.
   */
  onClickCursor?: (row: number, col: number) => void;
  /**
   * Right button pressed on the buffer. `cell` is the ABSOLUTE screen
   * cell (not text-relative like the click callbacks): it anchors the
   * context menu, which floats in screen space. Return whether the
   * press was consumed — the owner declines when no menu can open.
   */
  onSecondaryPress?: (cell: { x: number; y: number }) => boolean;
  /**
   * Most buffer lines painted at once. Beyond it the body renders a
   * cursor-tracking window (`computeRowWindow`, the same mechanism the
   * manage panels use) instead of every line: the composer overlay this
   * body sits in must stop growing before it climbs under the status
   * bar. Omitted (component tests, the wizard) means unbounded.
   */
  maxVisibleLines?: number;
  /**
   * Mouse layer for the body's click target. The composer overlay
   * paints over the chat log, so its editor registers above
   * `MOUSE_LAYER_BASE` — otherwise a small chat control underneath
   * would win the innermost-first sort and steal the click.
   */
  mouseLayer?: number;
}

/**
 * Rendering slice of the multi-line editor. Pure presentation — all key
 * handling and buffer state lives in `multi-line-editor.tsx`; splitting
 * the body keeps each file within the 300-LOC budget without duplicating
 * logic.
 */
export function EditorBody({
  value,
  cursor,
  placeholder,
  focus,
  selection = null,
  onClickCursor,
  onSecondaryPress,
  onDragStart,
  onDragMove,
  onDragEnd,
  maxVisibleLines,
  mouseLayer,
}: EditorBodyProps): ReactElement {
  // One target for the whole buffer: the click's local row is the line,
  // its local column minus the gutter is the character. Lines are not
  // soft-wrapped here, so the mapping is exact.
  const mouse = useMouseCommands();
  /**
   * Whether the drag in progress started here. Motion and release are
   * hit-tested by position like any other event, so a drag that began in
   * the chat log and merely passes over the composer would otherwise
   * move its caret — and, with a selection live, silently re-point one
   * end of it. Only a press on this target opens the gesture.
   */
  const draggingRef = useRef(false);
  const lines = value.split("\n");
  // The visible slice of the buffer. `computeRowWindow` keeps the
  // cursor's line in view, which is the line every keystroke edits, so
  // typing at the cap scrolls the window rather than the composer.
  const lineWindow = computeRowWindow(
    lines.length,
    cursor.row,
    maxVisibleLines ?? lines.length,
  );
  const bodyRef = useMouseTarget((hit) => {
    // Local rows are window rows: the body only paints the slice, so a
    // click's line index is offset by everything scrolled off above.
    const row = lineWindow.start + hit.localY;
    const col = hit.localX - GUTTER_COLUMNS;
    if (isSecondaryPress(hit.event)) {
      // The menu anchors at the clicked SCREEN cell, so the local
      // coordinates are folded back into absolutes here — the one place
      // that has both the rect and the local offsets.
      return (
        onSecondaryPress?.({
          x: hit.rect.left + hit.localX,
          y: hit.rect.top + hit.localY,
        }) ?? false
      );
    }
    // A press starts a drag AND places the caret: press-move-release is
    // one gesture, and a press that turns out to be a plain click has
    // already done the right thing by the time the release arrives.
    if (isPrimaryPress(hit.event)) {
      onClickCursor?.(row, col);
      onDragStart?.(row, col);
      // Take the pointer for the gesture: hit-testing routes by
      // position, so a drag that wanders out of the composer would
      // otherwise deliver its motion — and its release — to whatever
      // sits under the cursor, leaving the selection neither extended
      // nor ended.
      draggingRef.current = true;
      mouse?.registry.capturePointer(bodyRef);
      return true;
    }
    if (!draggingRef.current) return false;
    if (hit.event.kind === "motion" && hit.event.button === "left") {
      onDragMove?.(row, col);
      return true;
    }
    if (hit.event.kind === "release") {
      draggingRef.current = false;
      mouse?.registry.releasePointer();
      onDragEnd?.();
      return true;
    }
    return false;
  }, { layer: mouseLayer });
  if (value.length === 0) {
    return (
      <Box ref={bodyRef}>
        <Text color={theme.colors.accent}>{theme.glyphs.promptCaret} </Text>
        {focus ? <Text inverse> </Text> : null}
        <Text color={theme.colors.muted}>{placeholder}</Text>
      </Box>
    );
  }
  // Buffer offset of each line's first character; +1 per newline.
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const visible = lines.slice(lineWindow.start, lineWindow.start + lineWindow.count);
  return (
    <Box flexDirection="column" ref={bodyRef}>
      {visible.map((line, sliceIdx) => {
        // Everything buffer-relative — the caret glyph, the cursor row,
        // the selection clip — keys off the real line index, not the
        // slice position, or scrolling the window would move them all.
        const idx = lineWindow.start + sliceIdx;
        return (
          <Box key={idx}>
            <Text color={theme.colors.accent}>
              {idx === 0 ? `${theme.glyphs.promptCaret} ` : "  "}
            </Text>
            {renderLine({
              line,
              cursorCol: idx === cursor.row ? cursor.col : -1,
              focus,
              // Offsets of this line within the buffer, so the selection
              // (which is buffer-relative) can be clipped to it.
              lineStart: lineStarts[idx] ?? 0,
              selection,
            })}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * One rendered line: the selected span in inverse video, and the caret
 * as an inverse cell. When both want the same cell the selection wins —
 * a caret drawn inside a highlighted run would be an inverse cell on an
 * inverse ground, i.e. invisible.
 */
function renderLine({
  line,
  cursorCol,
  focus,
  lineStart,
  selection,
}: {
  line: string;
  cursorCol: number;
  focus: boolean;
  lineStart: number;
  selection: readonly [number, number] | null;
}): ReactElement {
  const span = selection ? clipToLine(selection, lineStart, line.length) : null;
  if (span) {
    const [from, to] = span;
    return (
      <Text>
        {line.slice(0, from)}
        <Text inverse>{line.slice(from, to)}</Text>
        {line.slice(to)}
      </Text>
    );
  }
  if (cursorCol < 0 || !focus) {
    return <Text>{line}</Text>;
  }
  const before = line.slice(0, cursorCol);
  const atCursor = line[cursorCol] ?? " ";
  const after = line.slice(cursorCol + 1);
  return (
    <Text>
      {before}
      <Text inverse>{atCursor}</Text>
      {after}
    </Text>
  );
}

/**
 * Intersect a buffer-relative selection with one line, returning
 * line-relative columns, or `null` when the line is outside it.
 */
function clipToLine(
  selection: readonly [number, number],
  lineStart: number,
  lineLength: number,
): [number, number] | null {
  const lineEnd = lineStart + lineLength;
  const from = Math.max(selection[0], lineStart);
  const to = Math.min(selection[1], lineEnd);
  if (to <= from) return null;
  return [from - lineStart, to - lineStart];
}
