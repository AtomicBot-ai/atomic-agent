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
import { getAppVersion } from "../../version.js";
import { LOGO_ART } from "./logo.js";

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
  /** Short session id, shown under the wordmark. */
  sessionId?: string | null;
  /** Where the operator is, e.g. `Manage › Tasks`. */
  location?: string;
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
 * The app rail: brand mark, menu button, where you are, then Sessions
 * and Tasks. Always on screen, on the **left**, drawn on its own
 * inverted ground.
 *
 * It used to be a plain right-hand list of sessions with the app title
 * on a separate bar across the top. That is two pieces of chrome doing
 * one job. Everything that says "which app, which version, where am I,
 * what else is there" now lives in one column, which is where a reader
 * coming from any normal application will look for it — and the top bar
 * is gone entirely.
 *
 * **Why the inverted ground.** A terminal has no borders-and-shadows to
 * separate regions, so two columns of the same text on the same ground
 * read as one wrapped document. Giving the rail its own ground is the
 * cheapest honest way to say "this is chrome, that is content". It is
 * per-palette rather than literally white: `#fff` would vanish on the
 * four light themes, and the property that has to hold is inversion.
 *
 * The ground is one `backgroundColor` on the rail container, so it fills
 * the column's whole height on its own. Painting it line by line instead
 * needs filler rows to reach the bottom, and a rail taller than the
 * terminal makes Ink 7 overlap earlier lines rather than clip — the same
 * trap `splash-fit.ts` exists to avoid.
 *
 * Purely presentational: it never measures the terminal, so the same
 * component works under ink-testing-library's static viewport. Width and
 * per-pane row budgets arrive as props from `TuiApp`.
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
    sessionId = null,
    location,
    maxSessionRows = DEFAULT_MAX_SESSION_ROWS,
    maxTaskRows = DEFAULT_MAX_TASK_ROWS,
  } = props;
  const sessionsActive = focused && activeSection === "sessions";
  const tasksActive = focused && activeSection === "tasks";
  const inner = Math.max(1, width - 2);
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
      backgroundColor={theme.colors.railBackground}
      paddingX={1}
    >
      <RailBrand inner={inner} sessionId={sessionId} />
      <MenuButton inner={inner} />
      {location ? <RailLocation inner={inner} label={location} /> : null}
      <RailBlank />
      <SectionHeader title="Sessions" active={sessionsActive} inner={inner} />
      <SessionsList
        sessions={sessions}
        cursor={sessionsCursor}
        focused={sessionsActive}
        currentSessionId={currentSessionId}
        maxRows={maxSessionRows}
        previewWidth={previewWidth}
        inner={inner}
      />
      <RailBlank />
      <SectionHeader title="Tasks" active={tasksActive} inner={inner} />
      <TasksList
        tasks={tasks}
        cursor={tasksCursor}
        focused={tasksActive}
        maxRows={maxTaskRows}
        previewWidth={previewWidth}
        inner={inner}
      />
      <Box flexGrow={1} />
    </Box>
  );
}

/** Clip to `width` columns; the ground is painted by the container. */
function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length > width) {
    return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
  }
  return text;
}

/**
 * One rail line. The text is clipped to the rail width but not padded —
 * the container's `backgroundColor` paints the rest of the row.
 */
function RailLine({
  inner,
  children,
  color,
  bold,
}: {
  inner: number;
  children: string;
  color?: string;
  bold?: boolean;
}): ReactElement {
  return (
    <Text
      color={color ?? theme.colors.railForeground}
      bold={bold ?? false}
      wrap="truncate"
    >
      {clip(children, inner)}
    </Text>
  );
}

/**
 * One row of breathing space. An empty `<Text>` collapses to zero height
 * in Ink, so the spacer has to be a sized Box.
 */
function RailBlank(): ReactElement {
  return <Box height={1} flexShrink={0} />;
}

/** Mark, wordmark, version, session id. */
function RailBrand({
  inner,
  sessionId,
}: {
  inner: number;
  sessionId: string | null;
}): ReactElement {
  const art = LOGO_ART.mini;
  return (
    <Box flexDirection="column">
      <RailBlank />
      {art.map((row, idx) => (
        <RailLine key={idx} inner={inner} color={theme.colors.brandMark} bold>
          {row}
        </RailLine>
      ))}
      <RailLine inner={inner} bold>
        {"atomic-agent"}
      </RailLine>
      <RailLine inner={inner} color={theme.colors.railMuted}>
        {`v${getAppVersion()}${sessionId ? `  ·  ${shortenId(sessionId)}` : ""}`}
      </RailLine>
      <RailBlank />
    </Box>
  );
}

/**
 * The one control on the rail. `ctrl+p` opens the same menu; this is
 * what makes it reachable without knowing that, which was the whole
 * complaint about the old top bar — nothing on screen said the menu
 * existed.
 */
function MenuButton({ inner }: { inner: number }): ReactElement {
  const mouse = useMouseCommands();
  const label = (
    <RailLine inner={inner} bold>
      {`${theme.glyphs.menuGlyph} Menu${" ".repeat(Math.max(1, inner - 17))}ctrl+p`}
    </RailLine>
  );
  if (!mouse) return label;
  return (
    <MouseTarget
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        mouse.dispatch({ type: "menu_opened" });
        return true;
      }}
    >
      {label}
    </MouseTarget>
  );
}

/** Where you are — the breadcrumb the removed top bar used to carry. */
function RailLocation({
  inner,
  label,
}: {
  inner: number;
  label: string;
}): ReactElement {
  return (
    <RailLine inner={inner} color={theme.colors.railMuted}>
      {label}
    </RailLine>
  );
}

function shortenId(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 8)}…`;
}

interface SectionHeaderProps {
  title: string;
  active: boolean;
  inner: number;
}

function SectionHeader({ title, active, inner }: SectionHeaderProps): ReactElement {
  return (
    <RailLine
      inner={inner}
      bold
      color={active ? theme.colors.accent : theme.colors.railForeground}
    >
      {title.toUpperCase()}
    </RailLine>
  );
}

interface SessionsListProps {
  sessions: readonly SessionPickerEntry[];
  cursor: number;
  focused: boolean;
  currentSessionId: string | null;
  maxRows: number;
  previewWidth: number;
  inner: number;
}

function SessionsList({
  sessions,
  cursor,
  focused,
  currentSessionId,
  maxRows,
  previewWidth,
  inner,
}: SessionsListProps): ReactElement {
  if (sessions.length === 0) {
    return (
      <RailLine inner={inner} color={theme.colors.railMuted}>
        {"(no sessions yet)"}
      </RailLine>
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
            inner={inner}
          />
        </SidebarRow>
      ))}
      <MoreRow hidden={window.hiddenAfter} inner={inner} />
    </Box>
  );
}

interface SessionRowProps {
  entry: SessionPickerEntry;
  selected: boolean;
  current: boolean;
  previewWidth: number;
  inner: number;
}

function SessionRow({
  entry,
  selected,
  current,
  previewWidth,
  inner,
}: SessionRowProps): ReactElement {
  const preview = truncate(entry.preview, previewWidth);
  const marker = current ? theme.glyphs.assistantMarker : " ";
  const chevron = selected ? theme.glyphs.chevronRight : " ";
  return (
    <RailLine
      inner={inner}
      bold={selected || current}
      color={selected ? theme.colors.accent : theme.colors.railForeground}
    >
      {`${chevron} ${marker} ${preview}`}
    </RailLine>
  );
}

interface TasksListProps {
  tasks: readonly TaskSummaryRow[];
  cursor: number;
  focused: boolean;
  maxRows: number;
  previewWidth: number;
  inner: number;
}

function TasksList({
  tasks,
  cursor,
  focused,
  maxRows,
  previewWidth,
  inner,
}: TasksListProps): ReactElement {
  if (tasks.length === 0) {
    return (
      <RailLine inner={inner} color={theme.colors.railMuted}>
        {"(no active tasks)"}
      </RailLine>
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
            inner={inner}
          />
        </SidebarRow>
      ))}
      <MoreRow hidden={window.hiddenAfter} inner={inner} />
    </Box>
  );
}

interface TaskRowProps {
  row: TaskSummaryRow;
  selected: boolean;
  previewWidth: number;
  inner: number;
}

function TaskRow({
  row,
  selected,
  previewWidth,
  inner,
}: TaskRowProps): ReactElement {
  const preview = truncate(row.userMessage, previewWidth);
  const chevron = selected ? theme.glyphs.chevronRight : " ";
  const badge = statusBadge(row);
  return (
    <RailLine
      inner={inner}
      bold={selected}
      color={selected ? theme.colors.accent : theme.colors.railForeground}
    >
      {`${chevron} ${badge} ${preview}`}
    </RailLine>
  );
}

/** "↓ N more" footer, or nothing at all when the tail is visible. */
function MoreRow({
  hidden,
  inner,
}: {
  hidden: number;
  inner: number;
}): ReactElement | null {
  if (hidden <= 0) return null;
  return (
    <RailLine inner={inner} color={theme.colors.railMuted}>
      {`↓ ${hidden} more`}
    </RailLine>
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
