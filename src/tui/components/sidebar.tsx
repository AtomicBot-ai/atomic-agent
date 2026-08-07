import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { TaskSummaryRow } from "../tasks/tasks-panel-state.js";
import { theme } from "../theme/theme.js";
import type { SessionPickerEntry } from "../tui-state.js";

export type SidebarSection = "sessions" | "tasks";

export interface SidebarProps {
  width: number;
  sessions: readonly SessionPickerEntry[];
  sessionsCursor: number;
  currentSessionId: string | null;
  tasks: readonly TaskSummaryRow[];
  tasksCursor: number;
  /** Which sub-pane is the focus stop (only highlighted when `focused`). */
  activeSection: SidebarSection;
  /** Whether the sidebar owns keyboard focus right now. */
  focused: boolean;
}

const MAX_SESSION_ROWS = 10;
const MAX_TASK_ROWS = 5;

/**
 * Always-on right-rail sidebar. Two stacked panes — Sessions (top) and
 * Tasks (bottom) — both navigable when the sidebar has focus. Tab
 * cycles editor → sessions → tasks → editor (handled by
 * `app-key-bindings.ts`); the sidebar component itself is purely
 * presentational and never measures the terminal directly so the
 * same component works under ink-testing-library's static viewport.
 *
 * Focus is layered: `focused` toggles the section header colour for
 * the active pane, and `activeSection` decides which pane gets the
 * cursor highlight. When `focused` is false, both panes render in
 * their muted resting state.
 */
export function Sidebar(props: SidebarProps): ReactElement {
  const {
    width,
    sessions,
    sessionsCursor,
    currentSessionId,
    tasks,
    tasksCursor,
    activeSection,
    focused,
  } = props;
  const sessionsActive = focused && activeSection === "sessions";
  const tasksActive = focused && activeSection === "tasks";
  return (
    <Box
      width={width}
      flexDirection="column"
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderLeft
      borderColor={theme.colors.border}
      paddingLeft={1}
      paddingRight={1}
    >
      <SectionHeader title="Sessions" active={sessionsActive} />
      <SessionsList
        sessions={sessions}
        cursor={sessionsCursor}
        focused={sessionsActive}
        currentSessionId={currentSessionId}
      />
      <Box marginTop={1}>
        <SectionHeader title="Tasks" active={tasksActive} />
      </Box>
      <TasksList
        tasks={tasks}
        cursor={tasksCursor}
        focused={tasksActive}
      />
    </Box>
  );
}

interface SectionHeaderProps {
  title: string;
  active: boolean;
}

function SectionHeader({ title, active }: SectionHeaderProps): ReactElement {
  return (
    <Text color={active ? theme.colors.accentSoft : theme.colors.muted} bold>
      {title}
    </Text>
  );
}

interface SessionsListProps {
  sessions: readonly SessionPickerEntry[];
  cursor: number;
  focused: boolean;
  currentSessionId: string | null;
}

function SessionsList({
  sessions,
  cursor,
  focused,
  currentSessionId,
}: SessionsListProps): ReactElement {
  if (sessions.length === 0) {
    return (
      <Text color={theme.colors.muted}>(no sessions yet)</Text>
    );
  }
  const clamped = Math.max(0, Math.min(cursor, sessions.length - 1));
  const windowStart = computeWindowStart(clamped, sessions.length, MAX_SESSION_ROWS);
  const visible = sessions.slice(windowStart, windowStart + MAX_SESSION_ROWS);
  const visibleCursor = clamped - windowStart;
  const hiddenAfter = Math.max(0, sessions.length - windowStart - visible.length);
  return (
    <Box flexDirection="column">
      {visible.map((entry, idx) => (
        <SessionRow
          key={entry.sessionId}
          entry={entry}
          selected={focused && idx === visibleCursor}
          current={entry.sessionId === currentSessionId}
        />
      ))}
      {hiddenAfter > 0 ? (
        <Text color={theme.colors.muted}>↓ {hiddenAfter} more</Text>
      ) : null}
    </Box>
  );
}

interface SessionRowProps {
  entry: SessionPickerEntry;
  selected: boolean;
  current: boolean;
}

function SessionRow({ entry, selected, current }: SessionRowProps): ReactElement {
  const preview = truncate(entry.preview, 28);
  const marker = current ? theme.glyphs.assistantMarker : " ";
  const chevron = selected ? theme.glyphs.chevronRight : " ";
  return (
    <Text
      color={selected ? theme.colors.accentSoft : theme.colors.muted}
      bold={selected || current}
      wrap="truncate"
    >
      {chevron} {marker} {preview}
    </Text>
  );
}

interface TasksListProps {
  tasks: readonly TaskSummaryRow[];
  cursor: number;
  focused: boolean;
}

function TasksList({ tasks, cursor, focused }: TasksListProps): ReactElement {
  if (tasks.length === 0) {
    return <Text color={theme.colors.muted}>(no active tasks)</Text>;
  }
  const clamped = Math.max(0, Math.min(cursor, tasks.length - 1));
  const visible = tasks.slice(0, MAX_TASK_ROWS);
  const visibleCursor = Math.min(clamped, visible.length - 1);
  return (
    <Box flexDirection="column">
      {visible.map((row, idx) => (
        <TaskRow
          key={row.id}
          row={row}
          selected={focused && idx === visibleCursor}
        />
      ))}
    </Box>
  );
}

interface TaskRowProps {
  row: TaskSummaryRow;
  selected: boolean;
}

function TaskRow({ row, selected }: TaskRowProps): ReactElement {
  const preview = truncate(row.userMessage, 24);
  const chevron = selected ? theme.glyphs.chevronRight : " ";
  const badge = statusBadge(row);
  return (
    <Text
      color={selected ? theme.colors.accentSoft : theme.colors.muted}
      bold={selected}
      wrap="truncate"
    >
      {chevron} {badge} {preview}
    </Text>
  );
}

/**
 * One-glyph status indicator: ● running, ○ pending, ↻ recurring (when
 * the task is not currently running or queued), · for the rare other
 * statuses that still slip through the selector.
 */
function statusBadge(row: TaskSummaryRow): string {
  if (row.status === "running") return "●";
  if (row.status === "pending") return "○";
  if (row.recurring) return "↻";
  return "·";
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return "(empty)";
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

function computeWindowStart(cursor: number, total: number, size: number): number {
  if (total <= size) return 0;
  if (cursor < size) return 0;
  return Math.min(cursor - size + 1, total - size);
}
