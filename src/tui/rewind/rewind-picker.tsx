import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { RewindPoint } from "../../session/session-rewind.js";
import { rewindPreview } from "../../session/session-rewind.js";
import { MouseListRow } from "../mouse/mouse-list-row.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import { handleEditorSubmit } from "../submit-handler.js";
import { theme } from "../theme/theme.js";

export interface RewindPickerProps {
  /** The chat's earlier questions, newest first. */
  points: readonly RewindPoint[];
  cursor: number;
}

const MAX_ROWS = 10;

/**
 * `/rewind` (ATO-1057): the chat's earlier questions, rendered above the
 * editor while `state.rewindPicker` is set. Keys are the editor's own,
 * like the session picker's: Up/Down move, Enter takes the chat back to
 * just before the highlighted question, Esc closes. A click selects, a
 * second click (or Enter) rewinds.
 */
export function RewindPicker(props: RewindPickerProps): ReactElement {
  const { points, cursor } = props;
  const clamped = Math.max(0, Math.min(cursor, points.length - 1));
  const windowStart = computeWindowStart(clamped, points.length, MAX_ROWS);
  const visible = points.slice(windowStart, windowStart + MAX_ROWS);
  const visibleCursor = clamped - windowStart;
  const hiddenAfter = Math.max(0, points.length - windowStart - visible.length);
  return (
    <Box
      borderStyle="round"
      borderColor={theme.colors.accent}
      paddingX={1}
      flexDirection="column"
    >
      <Text color={theme.colors.muted}>
        rewind to a message ({points.length}) — Enter removes it and everything
        after, then puts it back here to edit · Esc to cancel
      </Text>
      {windowStart > 0 ? (
        <Text color={theme.colors.muted}>↑ {windowStart} newer</Text>
      ) : null}
      {visible.map((point, idx) => (
        <MouseListRow
          key={point.turnIndex}
          layer={MOUSE_LAYER_MODAL}
          selected={idx === visibleCursor}
          onSelect={(mouse) =>
            mouse.dispatch({
              type: "rewind_picker_cursor_set",
              row: windowStart + idx,
            })
          }
          onActivate={(mouse) =>
            handleEditorSubmit(
              "",
              mouse.getState(),
              mouse.dispatch,
              mouse.callbacks,
            )
          }
        >
          <RewindRow point={point} selected={idx === visibleCursor} />
        </MouseListRow>
      ))}
      {hiddenAfter > 0 ? (
        <Text color={theme.colors.muted}>↓ {hiddenAfter} older</Text>
      ) : null}
    </Box>
  );
}

function computeWindowStart(cursor: number, total: number, size: number): number {
  if (total <= size) return 0;
  if (cursor < size) return 0;
  return Math.min(cursor - size + 1, total - size);
}

function RewindRow({
  point,
  selected,
}: {
  point: RewindPoint;
  selected: boolean;
}): ReactElement {
  const chevron = selected ? theme.glyphs.chevronRight : " ";
  return (
    <Box>
      <Text
        color={selected ? theme.colors.accentSoft : theme.colors.muted}
        bold={selected}
      >
        {chevron} #{point.ordinal}
      </Text>
      <Text color={selected ? undefined : theme.colors.muted}>
        {"  "}
        {rewindPreview(point.text, 60) || "(empty message)"}
      </Text>
    </Box>
  );
}
