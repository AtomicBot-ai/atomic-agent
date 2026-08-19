import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { SessionPickerEntry } from "../tui-state.js";
import { theme } from "../theme/theme.js";
import { MouseListRow } from "../mouse/mouse-list-row.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import { handleEditorSubmit } from "../submit-handler.js";

export interface SessionPickerProps {
  sessions: readonly SessionPickerEntry[];
  cursor: number;
  currentSessionId: string | null;
}

const MAX_ROWS = 10;

/**
 * Overlay list of recent sessions. Rendered above the editor when
 * `state.sessionPickerOpen` is true. Keyboard handling (Up/Down to move,
 * Enter to switch, Esc to close) is driven from the app shell.
 */
export function SessionPicker(props: SessionPickerProps): ReactElement {
  const { sessions, cursor, currentSessionId } = props;
  if (sessions.length === 0) {
    return (
      <Box borderStyle="round" borderColor={theme.colors.warn} paddingX={1}>
        <Text color={theme.colors.warn}>no persisted sessions yet</Text>
      </Box>
    );
  }
  const clamped = Math.max(0, Math.min(cursor, sessions.length - 1));
  const windowStart = computeWindowStart(clamped, sessions.length, MAX_ROWS);
  const visible = sessions.slice(windowStart, windowStart + MAX_ROWS);
  const visibleCursor = clamped - windowStart;
  const hiddenBefore = windowStart;
  const hiddenAfter = Math.max(0, sessions.length - windowStart - visible.length);
  return (
    <Box
      borderStyle="round"
      borderColor={theme.colors.accent}
      paddingX={1}
      flexDirection="column"
    >
      <Text color={theme.colors.muted}>
        sessions ({sessions.length}) — Enter to load, Esc to dismiss
      </Text>
      {hiddenBefore > 0 ? (
        <Text color={theme.colors.muted}>↑ {hiddenBefore} above</Text>
      ) : null}
      {visible.map((entry, idx) => (
        <MouseListRow
          key={entry.sessionId}
          layer={MOUSE_LAYER_MODAL}
          selected={idx === visibleCursor}
          onSelect={(mouse) =>
            mouse.dispatch({
              type: "session_picker_cursor_set",
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
          <PickerRow
            entry={entry}
            selected={idx === visibleCursor}
            current={entry.sessionId === currentSessionId}
          />
        </MouseListRow>
      ))}
      {hiddenAfter > 0 ? (
        <Text color={theme.colors.muted}>↓ {hiddenAfter} below</Text>
      ) : null}
    </Box>
  );
}

function computeWindowStart(cursor: number, total: number, size: number): number {
  if (total <= size) return 0;
  if (cursor < size) return 0;
  return Math.min(cursor - size + 1, total - size);
}

function PickerRow({
  entry,
  selected,
  current,
}: {
  entry: SessionPickerEntry;
  selected: boolean;
  current: boolean;
}): ReactElement {
  const idShort = entry.sessionId.length > 10
    ? `${entry.sessionId.slice(0, 10)}…`
    : entry.sessionId;
  const when = formatRelative(entry.updatedAt);
  const cwd = shortenCwd(entry.workingDir);
  const preview = truncate(entry.preview, 48);
  const marker = current ? theme.glyphs.assistantMarker : " ";
  const chevron = selected ? theme.glyphs.chevronRight : " ";
  return (
    <Box>
      <Text color={selected ? theme.colors.accentSoft : theme.colors.muted} bold={selected}>
        {chevron} {marker} {idShort}
      </Text>
      <Text color={theme.colors.muted}>
        {"  "}
        {when} · {entry.turnCount} turn{entry.turnCount === 1 ? "" : "s"} · {cwd}
      </Text>
      {preview.length > 0 ? (
        <Text color={theme.colors.muted}>
          {"  — "}
          {preview}
        </Text>
      ) : null}
    </Box>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function shortenCwd(dir: string): string {
  const home = process.env["HOME"];
  const short = home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
  if (short.length <= 32) return short;
  return `…${short.slice(-31)}`;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}
