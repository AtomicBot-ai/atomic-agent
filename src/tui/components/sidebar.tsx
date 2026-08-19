import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";
import {
  MouseTarget,
  useMouseCommands,
  useMouseTarget,
} from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { computeRowWindow } from "../row-window.js";
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
  /**
   * Row budget for each pane, normally derived from the terminal height
   * by `computeSidebarRowBudget` in `../layout.ts`. The defaults keep
   * the pre-adaptive behaviour for callers that do not measure.
   */
  maxSessionRows?: number;
  maxTaskRows?: number;
}

const DEFAULT_MAX_SESSION_ROWS = 10;
const DEFAULT_MAX_TASK_ROWS = 5;

/**
 * Cells each list row spends before the preview text: the border, the
 * two padding columns, the selection chevron and the status marker,
 * plus the spaces between them.
 */
const ROW_CHROME_COLUMNS = 7;
/** Never squeeze a preview below this — an ellipsis alone helps nobody. */
const MIN_PREVIEW_COLUMNS = 6;

/**
 * Always-on right-rail sidebar. Two stacked panes — Sessions (top) and
 * Tasks (bottom) — both navigable when the sidebar has focus. Tab
 * cycles editor → sessions → tasks → editor (handled by
 * `app-key-bindings.ts`); the sidebar component itself is purely
 * presentational and never measures the terminal directly so the
 * same component works under ink-testing-library's static viewport.
 * Its width and per-pane row budgets arrive as props from `TuiApp`,
 * which owns the terminal measurement.
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
    maxSessionRows = DEFAULT_MAX_SESSION_ROWS,
    maxTaskRows = DEFAULT_MAX_TASK_ROWS,
  } = props;
  const sessionsActive = focused && activeSection === "sessions";
  const tasksActive = focused && activeSection === "tasks";
  const previewWidth = Math.max(
    MIN_PREVIEW_COLUMNS,
    width - ROW_CHROME_COLUMNS,
  );
  const mouse = useMouseCommands();
  // Wheel over the rail walks the pane that owns the cursor, so the
  // gesture matches what ↑/↓ do once the rail has focus.
  const wheelRef = useMouseTarget((hit) => {
    if (hit.event.kind !== "wheel" || !mouse) return false;
    const delta = hit.event.wheel === "up" ? -1 : 1;
    mouse.dispatch(
      activeSection === "tasks"
        ? { type: "sidebar_tasks_cursor_moved", delta }
        : { type: "sidebar_cursor_moved", delta },
    );
    return true;
  });
  // `flexShrink={0}`: Yoga shrinks flex children by default, so a wide
  // chat column used to steal columns back from the rail — which made
  // the width the splash was told to plan for a lie.
  return (
    <Box
      ref={wheelRef}
      width={width}
      flexShrink={0}
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
        maxRows={maxSessionRows}
        previewWidth={previewWidth}
      />
      <Box marginTop={1}>
        <SectionHeader title="Tasks" active={tasksActive} />
      </Box>
      <TasksList
        tasks={tasks}
        cursor={tasksCursor}
        focused={tasksActive}
        maxRows={maxTaskRows}
        previewWidth={previewWidth}
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
  maxRows: number;
  previewWidth: number;
}

function SessionsList({
  sessions,
  cursor,
  focused,
  currentSessionId,
  maxRows,
  previewWidth,
}: SessionsListProps): ReactElement {
  if (sessions.length === 0) {
    return (
      <Text color={theme.colors.muted} wrap="truncate">
        (no sessions yet)
      </Text>
    );
  }
  const window = computeRowWindow(sessions.length, cursor, maxRows);
  const visible = sessions.slice(window.start, window.start + window.count);
  const visibleCursor =
    Math.max(0, Math.min(cursor, sessions.length - 1)) - window.start;
  return (
    <Box flexDirection="column">
      {visible.map((entry, idx) => (
        <SidebarRow
          key={entry.sessionId}
          section="sessions"
          row={window.start + idx}
          selected={focused && idx === visibleCursor}
          onActivate={(mouse) =>
            mouse.callbacks.onSessionSwitchRequested?.(entry.sessionId)
          }
        >
          <SessionRow
            entry={entry}
            selected={focused && idx === visibleCursor}
            current={entry.sessionId === currentSessionId}
            previewWidth={previewWidth}
          />
        </SidebarRow>
      ))}
      <MoreRow hidden={window.hiddenAfter} />
    </Box>
  );
}

interface SessionRowProps {
  entry: SessionPickerEntry;
  selected: boolean;
  current: boolean;
  previewWidth: number;
}

function SessionRow({
  entry,
  selected,
  current,
  previewWidth,
}: SessionRowProps): ReactElement {
  const preview = truncate(entry.preview, previewWidth);
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
  maxRows: number;
  previewWidth: number;
}

function TasksList({
  tasks,
  cursor,
  focused,
  maxRows,
  previewWidth,
}: TasksListProps): ReactElement {
  if (tasks.length === 0) {
    return (
      <Text color={theme.colors.muted} wrap="truncate">
        (no active tasks)
      </Text>
    );
  }
  const window = computeRowWindow(tasks.length, cursor, maxRows);
  const visible = tasks.slice(window.start, window.start + window.count);
  const visibleCursor =
    Math.max(0, Math.min(cursor, tasks.length - 1)) - window.start;
  return (
    <Box flexDirection="column">
      {visible.map((row, idx) => (
        <SidebarRow
          key={row.id}
          section="tasks"
          row={window.start + idx}
          selected={focused && idx === visibleCursor}
          onActivate={(mouse) =>
            mouse.callbacks.onSidebarTaskActivated?.(row.id)
          }
        >
          <TaskRow
            row={row}
            selected={focused && idx === visibleCursor}
            previewWidth={previewWidth}
          />
        </SidebarRow>
      ))}
      <MoreRow hidden={window.hiddenAfter} />
    </Box>
  );
}

interface TaskRowProps {
  row: TaskSummaryRow;
  selected: boolean;
  previewWidth: number;
}

function TaskRow({ row, selected, previewWidth }: TaskRowProps): ReactElement {
  const preview = truncate(row.userMessage, previewWidth);
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

/** "↓ N more" footer, or nothing at all when the tail is visible. */
function MoreRow({ hidden }: { hidden: number }): ReactElement | null {
  if (hidden <= 0) return null;
  return (
    <Text color={theme.colors.muted} wrap="truncate">
      ↓ {hidden} more
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
  return `${oneLine.slice(0, Math.max(1, max - 1))}…`;
}

interface SidebarRowProps {
  section: SidebarSection;
  /** Absolute index into the pane's data, not the visible window. */
  row: number;
  selected: boolean;
  onActivate: (mouse: NonNullable<ReturnType<typeof useMouseCommands>>) => void;
  children: ReactNode;
}

/**
 * Click behaviour shared by both rails: the first click focuses the
 * rail and moves the cursor, a click on the row that is already
 * selected activates it. Two deliberate clicks instead of a
 * double-click — no timing window to guess, and it matches what the
 * keyboard does (arrow to the row, then Enter).
 */
function SidebarRow({
  section,
  row,
  selected,
  onActivate,
  children,
}: SidebarRowProps): ReactElement {
  const mouse = useMouseCommands();
  if (!mouse) return <>{children}</>;
  return (
    <MouseTarget
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        if (selected) {
          onActivate(mouse);
          return true;
        }
        mouse.dispatch({ type: "chat_focus_set", focus: "sidebar" });
        mouse.dispatch({ type: "sidebar_section_focused", section });
        mouse.dispatch(
          section === "tasks"
            ? { type: "sidebar_tasks_cursor_set", row }
            : { type: "sidebar_cursor_set", row },
        );
        return true;
      }}
    >
      {children}
    </MouseTarget>
  );
}
