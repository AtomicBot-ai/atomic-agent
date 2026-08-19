import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { MouseListRow, pressEnter } from "../mouse/mouse-list-row.js";
import { handleTasksTabKey } from "../tasks/tasks-key-bindings.js";
import {
  computeTaskListLayout,
  computeTasksListFit,
  describeEmptyTaskList,
  fitTaskListHints,
  formatTaskListHeader,
  formatTaskRowCells,
  type TaskListLayout,
} from "../tasks/tasks-list-fit.js";
import { computeRowWindow } from "../row-window.js";
import type {
  TaskSummaryRow,
  TasksPanelState,
} from "../tasks/tasks-panel-state.js";
import type { TaskStatus } from "../../tasks/task-types.js";

export interface TasksListProps {
  panel: TasksPanelState;
  visibleRows: readonly TaskSummaryRow[];
  /** Rows the whole table may occupy, chrome included. */
  maxRows: number;
  now: number;
  /** Columns the panel owns — see `tasks-list-fit.ts` for why it matters. */
  width: number;
}

/**
 * Scrollable table view. `visibleRows` is already filtered + sorted by
 * the caller; this component owns only the cursor windowing and the
 * per-row rendering contract.
 *
 * Every column width — including the footer hints — comes from
 * `tasks-list-fit.ts` for the panel's real width, because a row that
 * wraps takes two terminal lines and collides its own columns into
 * each other. `maxRows` is the budget for the *whole* table, header and
 * hints included: the header, the scroll markers and the hint strip
 * used to be drawn on top of it, which is how the panel outgrew the
 * space the debug pane had reserved.
 */
export function TasksList(props: TasksListProps): ReactElement {
  const { panel, visibleRows, maxRows, now, width } = props;
  const layout = computeTaskListLayout(width);
  if (visibleRows.length === 0) {
    return <EmptyState panel={panel} width={width} maxRows={maxRows} />;
  }
  const fit = computeTasksListFit(maxRows, visibleRows.length);
  const clamped = Math.max(0, Math.min(panel.cursor, visibleRows.length - 1));
  const rowWindow = computeRowWindow(visibleRows.length, clamped, fit.listRows);
  const windowStart = rowWindow.start;
  const pageRows = visibleRows.slice(windowStart, windowStart + rowWindow.count);
  const { hiddenBefore, hiddenAfter } = rowWindow;
  return (
    <Box flexDirection="column">
      {fit.header ? <HeaderRow layout={layout} /> : null}
      {hiddenBefore > 0 ? (
        <Text color={theme.colors.muted}>
          ↑ {hiddenBefore} above
        </Text>
      ) : null}
      {pageRows.map((row, idx) => (
        <MouseListRow
          key={row.id}
          selected={idx + windowStart === clamped}
          onSelect={(mouse) =>
            mouse.dispatch({ type: "tasks_cursor_set", row: idx + windowStart })
          }
          onActivate={pressEnter(handleTasksTabKey)}
        >
          <TaskRow
            row={row}
            layout={layout}
            selected={idx + windowStart === clamped}
            now={now}
          />
        </MouseListRow>
      ))}
      {hiddenAfter > 0 ? (
        <Text color={theme.colors.muted}>
          ↓ {hiddenAfter} below
        </Text>
      ) : null}
      {fit.hints ? <HintsRow width={width} spacer={fit.hintsSpacer} /> : null}
    </Box>
  );
}

/**
 * What the tab shows before the first task exists — and the screen a
 * first-run operator meets on `/tasks`. It carries the same hint strip
 * as the populated table: the keys are the only thing to learn here,
 * and hiding them until a task exists is a chicken-and-egg.
 */
function EmptyState({
  panel,
  width,
  maxRows,
}: {
  panel: TasksPanelState;
  width: number;
  maxRows: number;
}): ReactElement {
  const { headline, detail } = describeEmptyTaskList({
    totalRows: panel.rows.length,
    filterStatus: panel.filterStatus,
    searchQuery: panel.searchQuery,
  });
  // Same ladder as the table: spend rows on the message, then the
  // context line, then the breathing room around them.
  const roomy = maxRows >= 5;
  return (
    <Box flexDirection="column" paddingY={roomy ? 1 : 0}>
      <Text color={theme.colors.muted}>{headline}</Text>
      {detail && maxRows >= 3 ? (
        <Text color={theme.colors.muted}>{detail}</Text>
      ) : null}
      {maxRows >= 4 ? (
        <Box marginTop={roomy ? 1 : 0}>
          <Text color={theme.colors.muted}>{fitTaskListHints(width)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function HeaderRow({ layout }: { layout: TaskListLayout }): ReactElement {
  return (
    <Box>
      <Text color={theme.colors.muted}>{formatTaskListHeader(layout)}</Text>
    </Box>
  );
}

function HintsRow({
  width,
  spacer,
}: {
  width: number;
  spacer: boolean;
}): ReactElement {
  // The blank row above the hints is the house look for a manage panel,
  // but it is the first thing to go when the budget is tight: a hint
  // strip the operator can read beats the whitespace around it.
  return (
    <Box marginTop={spacer ? 1 : 0}>
      <Text color={theme.colors.muted}>{fitTaskListHints(width)}</Text>
    </Box>
  );
}

function TaskRow({
  row,
  layout,
  selected,
  now,
}: {
  row: TaskSummaryRow;
  layout: TaskListLayout;
  selected: boolean;
  now: number;
}): ReactElement {
  const chevron = selected ? theme.glyphs.chevronRight : " ";
  const cells = formatTaskRowCells(row, layout, now);
  const color = selected ? theme.colors.accentSoft : undefined;
  // The middle columns are one `<Text>` per cell rather than one joined
  // string so a dropped column takes its separating space with it.
  return (
    <Box>
      <Text color={color} bold={selected}>
        {chevron} <Text color={statusColor(row.status)}>{cells.status}</Text>
      </Text>
      <Text color={theme.colors.muted}>
        {cells.schedule ? ` ${cells.schedule}` : ""}
        {cells.nextRun ? ` ${cells.nextRun}` : ""}
        {cells.session ? ` ${cells.session}` : ""}
      </Text>
      <Text color={color}>{cells.message ? ` ${cells.message}` : ""}</Text>
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
