import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { Cursor } from "./multi-line-editor-cursor.js";

export interface EditorBodyProps {
  value: string;
  cursor: Cursor;
  placeholder: string;
  focus: boolean;
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
}: EditorBodyProps): ReactElement {
  if (value.length === 0) {
    return (
      <Box>
        <Text color={theme.colors.accent}>{theme.glyphs.promptCaret} </Text>
        {focus ? <Text inverse> </Text> : null}
        <Text color={theme.colors.muted}>{placeholder}</Text>
      </Box>
    );
  }
  const lines = value.split("\n");
  return (
    <Box flexDirection="column">
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
