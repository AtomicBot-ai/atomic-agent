import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { useMouseTarget } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
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
   * Move the caret to a clicked cell. `row`/`col` are already relative
   * to the text, gutter excluded; the owner clamps and converts them to
   * a buffer offset.
   */
  onClickCursor?: (row: number, col: number) => void;
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
  onClickCursor,
}: EditorBodyProps): ReactElement {
  // One target for the whole buffer: the click's local row is the line,
  // its local column minus the gutter is the character. Lines are not
  // soft-wrapped here, so the mapping is exact.
  const bodyRef = useMouseTarget((hit) => {
    if (!isPrimaryPress(hit.event) || !onClickCursor) return false;
    onClickCursor(hit.localY, hit.localX - GUTTER_COLUMNS);
    return true;
  });
  if (value.length === 0) {
    return (
      <Box ref={bodyRef}>
        <Text color={theme.colors.accent}>{theme.glyphs.promptCaret} </Text>
        {focus ? <Text inverse> </Text> : null}
        <Text color={theme.colors.muted}>{placeholder}</Text>
      </Box>
    );
  }
  const lines = value.split("\n");
  return (
    <Box flexDirection="column" ref={bodyRef}>
      {lines.map((line, idx) => (
        <Box key={idx}>
          <Text color={theme.colors.accent}>
            {idx === 0 ? `${theme.glyphs.promptCaret} ` : "  "}
          </Text>
          {renderLineWithCursor(
            line,
            idx === cursor.row ? cursor.col : -1,
            focus,
          )}
        </Box>
      ))}
    </Box>
  );
}

function renderLineWithCursor(
  line: string,
  cursorCol: number,
  focus: boolean,
): ReactElement {
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
