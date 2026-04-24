import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type {
  TaskSummaryRow,
  TasksPanelState,
} from "../tasks/tasks-panel-state.js";
import type { TaskStatus } from "../../tasks/task-types.js";
import { formatRelativeMs } from "../tasks/tasks-summary.js";

export interface TasksListProps {
  panel: TasksPanelState;
  visibleRows: readonly TaskSummaryRow[];
  maxRows: number;
  now: number;
}

/**
 * Scrollable table view. `visibleRows` is already filtered + sorted by
 * the caller; this component owns only the cursor windowing and the
 * per-row rendering contract.
 */
export function TasksList(props: TasksListProps): ReactElement {
  const { panel, visibleRows, maxRows, now } = props;
  if (visibleRows.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color={theme.colors.muted}>
          no tasks match the current filter — press `n` to create one,
          `f` to cycle filter, `r` to refresh.
        </Text>
      </Box>
    );
  }
  const clamped = Math.max(0, Math.min(panel.cursor, visibleRows.length - 1));
  const windowStart = computeWindowStart(clamped, visibleRows.length, maxRows);
  const pageRows = visibleRows.slice(windowStart, windowStart + maxRows);
  const hiddenBefore = windowStart;
  const hiddenAfter = Math.max(0, visibleRows.length - windowStart - pageRows.length);
  return (
    <Box flexDirection="column">
      <HeaderRow />
      {hiddenBefore > 0 ? (
        <Text color={theme.colors.muted}>
          ↑ {hiddenBefore} above
        </Text>
      ) : null}
      {pageRows.map((row, idx) => (
        <TaskRow
          key={row.id}
          row={row}
          selected={idx + windowStart === clamped}
          now={now}
        />
      ))}
      {hiddenAfter > 0 ? (
        <Text color={theme.colors.muted}>
          ↓ {hiddenAfter} below
        </Text>
      ) : null}
      <HintsRow />
    </Box>
  );
}

function HeaderRow(): ReactElement {
  return (
    <Box>
      <Text color={theme.colors.muted}>{"  "}status   schedule               next-run       session   message</Text>
    </Box>
  );
}

function HintsRow(): ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={theme.colors.muted}>
        j/k move · Enter detail · n new · c cancel · R run-now · r refresh
        · a auto · f filter · / search · Esc back
      </Text>
    </Box>
  );
}

function TaskRow({
  row,
  selected,
  now,
}: {
  row: TaskSummaryRow;
  selected: boolean;
  now: number;
}): ReactElement {
  const chevron = selected ? theme.glyphs.chevronRight : " ";
  const statusText = row.status.padEnd(9);
  const scheduleText = truncate(row.scheduleLabel, 22).padEnd(22);
  const nextRunText = formatRelativeMs(row.scheduledFor, now).padEnd(14);
  const sessionText = (row.sessionId ? shortId(row.sessionId) : "—").padEnd(10);
  const color = selected ? theme.colors.accentSoft : undefined;
  return (
    <Box>
      <Text color={color} bold={selected}>
        {chevron} <Text color={statusColor(row.status)}>{statusText}</Text>
      </Text>
      <Text color={theme.colors.muted}>
        {scheduleText} {nextRunText} {sessionText}
      </Text>
      <Text color={color}>{truncate(row.userMessage, 64)}</Text>
    </Box>
  );
}

function statusColor(status: TaskStatus): string {
  switch (status) {
    case "running":
      return theme.colors.info;
    case "completed":
      return theme.colors.success;
    case "failed":
    case "blocked":
      return theme.colors.error;
    case "cancelled":
      return theme.colors.warn;
    case "pending":
    default:
      return theme.colors.muted;
  }
}

function shortId(id: string): string {
  if (id.length <= 10) return id;
  return `${id.slice(0, 10)}…`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function computeWindowStart(cursor: number, total: number, size: number): number {
  if (total <= size) return 0;
  if (cursor < size) return 0;
  return Math.min(cursor - size + 1, total - size);
}
