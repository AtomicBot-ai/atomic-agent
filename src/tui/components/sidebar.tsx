import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";
import {
  MouseTarget,
  useMouseCommands,
  useMouseTarget,
} from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_BASE } from "../mouse/mouse-registry.js";
import { computeRowWindow } from "../row-window.js";
import type { TaskSummaryRow } from "../tasks/tasks-panel-state.js";
import { theme } from "../theme/theme.js";
import type { SessionPickerEntry } from "../tui-state.js";
import { getAppVersion } from "../../version.js";
import { RAIL_MARK } from "./logo.js";
import { Chip } from "./chip.js";

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
      {/*
        Three rows, not one. Sessions and Tasks read as a list the rail
        holds rather than as a continuation of the lockup, and the gap
        below the mark matches the one the composer now sets.
      */}
      <RailBlank />
      <RailBlank />
      <RailBlank />
      <SectionHeader
        title="Sessions"
        active={sessionsActive}
        inner={inner}
        trailing={<NewSessionButton />}
      />
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
      <SectionHeader
        title="Tasks"
        active={tasksActive}
        inner={inner}
        counter={`${runningCount(tasks)} running`}
      />
      <TasksList
        tasks={tasks}
        cursor={tasksCursor}
        focused={tasksActive}
        maxRows={maxTaskRows}
        previewWidth={previewWidth}
        inner={inner}
      />
      {/*
        The menu sits at the foot of the rail, the way an application
        parks its account or settings control: it is the thing you reach
        for occasionally, and the lists above it are what you look at.
        The spacer pushes it down however tall the terminal is.
      */}
      <Box flexGrow={1} />
      <MenuButton inner={inner} />
      {/*
        The design seats the Menu control above the rail's bottom edge
        rather than on it — a control flush against the edge of its own
        panel reads as part of the frame instead of as a button.
      */}
      <RailBlank />
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

/**
 * Mark, wordmark, version — the mark on the left with the text beside
 * it, the way a product lockup is normally set. Stacked, it spent six of
 * the rail's rows on branding before the first useful line.
 *
 * The session id keeps its own full-width row underneath: it is the one
 * piece here that can be long, and squeezing it into the column beside a
 * six-column mark would truncate it to nothing.
 */
function RailBrand({
  inner,
  sessionId,
}: {
  inner: number;
  sessionId: string | null;
}): ReactElement {
  const art = RAIL_MARK;
  const textWidth = Math.max(0, inner - MARK_COLUMNS - 1);
  return (
    <Box flexDirection="column">
      <RailBlank />
      <Box>
        <Box flexDirection="column" flexShrink={0}>
          {art.map((row, idx) => (
            <Text key={idx} color={theme.colors.railAccent} bold wrap="truncate">
              {row}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" flexShrink={0} paddingLeft={1}>
          {/*
            One blank: the mark is three rows and the text is two, so
            this seats the pair from the mark's centre row — the cross's
            own bar — rather than riding high against its top arm.
          */}
          <Text> </Text>
          <Text color={theme.colors.railForeground} bold wrap="truncate">
            {clip("atomic-agent", textWidth)}
          </Text>
          <Text color={theme.colors.railMuted} wrap="truncate">
            {clip(`v${getAppVersion()}`, textWidth)}
          </Text>
        </Box>
      </Box>
      {sessionId ? (
        <RailLine inner={inner} color={theme.colors.railMuted}>
          {shortenId(sessionId)}
        </RailLine>
      ) : null}
    </Box>
  );
}

/** Width of {@link RAIL_MARK}, kept beside it so the lockup can measure. */
const MARK_COLUMNS = 6;

/**
 * Starts a fresh thread. It sits on the Sessions header because that is
 * the list the thread joins — once it has been spoken to. A brand-new
 * session shows no row: it has no name yet, and an unnamed row is
 * indistinguishable from every other unnamed row. The row appears with
 * the first prompt, named by it.
 *
 * `/new` does the same thing, and used to be the only way to reach it —
 * which is not a thing a first-time operator knows.
 */
function NewSessionButton(): ReactElement {
  const mouse = useMouseCommands();
  const label = <Chip label="+ new" />;
  if (!mouse) return label;
  return (
    <MouseTarget
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        mouse.callbacks.onSessionNewRequested?.();
        return true;
      }}
    >
      {label}
    </MouseTarget>
  );
}

/**
 * The one control on the rail. Esc on an empty idle prompt opens the
 * same menu; this is what makes it reachable without knowing that,
 * which was the whole complaint about the old top bar — nothing on
 * screen said the menu existed.
 */
function MenuButton({ inner }: { inner: number }): ReactElement {
  const mouse = useMouseCommands();
  const label = (
    <Box width={inner} flexShrink={0}>
      <Chip label={`${theme.glyphs.menuGlyph} Menu`} />
      <Box flexGrow={1} />
      <Text color={theme.colors.railMuted} wrap="truncate">
        esc
      </Text>
    </Box>
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

function shortenId(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 8)}…`;
}

interface SectionHeaderProps {
  title: string;
  active: boolean;
  inner: number;
  /** Right-aligned status, e.g. `0 running`. */
  counter?: string;
  /** Right-aligned control, e.g. the `+ new` chip. */
  trailing?: ReactNode;
}

function SectionHeader({
  title,
  active,
  inner,
  counter,
  trailing,
}: SectionHeaderProps): ReactElement {
  // The header is a row, not a line: the counter and the `+ new` control
  // are pushed to the right edge of the rail the way the design sets
  // them, which a single clipped string cannot express.
  return (
    <Box width={inner} flexShrink={0}>
      <Text
        color={active ? theme.colors.railAccent : theme.colors.railForeground}
        bold
        wrap="truncate"
      >
        {title.toUpperCase()}
      </Text>
      <Box flexGrow={1} />
      {counter ? (
        <Text color={theme.colors.railMuted} wrap="truncate">
          {counter}
        </Text>
      ) : null}
      {trailing ?? null}
    </Box>
  );
}

/** Tasks the design counts in the header: the ones actually running. */
function runningCount(tasks: readonly TaskSummaryRow[]): number {
  return tasks.filter((row) => row.status === "running").length;
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
  // Two marks, two questions: the chevron is "Enter opens this row",
  // the dot is "this is the thread you are in". The ground answers the
  // first one too, but only in colour — and a colour is nothing under
  // NO_COLOR or in a pipe, so the glyph stays.
  const chevron = selected ? theme.glyphs.chevronRight : " ";
  const marker = current ? theme.glyphs.assistantMarker : " ";
  // The ground runs almost the full width of the rail with one column of
  // air either side, so a selected row reads as a row in a list rather
  // than as a highlighted word. The close affordance lives inside that
  // ground, at its right edge — visible only on the selected row,
  // because an `x` on every row is a mis-click waiting to happen.
  const groundWidth = Math.max(4, inner - 2 * ROW_MARGIN_COLUMNS);
  // The close columns are reserved on EVERY row, painted only on the
  // selected one. Sizing the preview by whether the row happens to be
  // selected made the mark materialise on top of text the operator was
  // already pointing at: the second click of the ordinary
  // select-then-open gesture landed on `[x]` and asked to delete the
  // thread instead of opening it.
  const preview = truncate(
    entry.preview,
    Math.max(1, Math.min(previewWidth, groundWidth - 5 - CLOSE_COLUMNS)),
  );
  const label = `${chevron} ${marker} ${preview}`;
  // Every cell width is computed here, so nothing may flex. Yoga
  // shrinks text children by default and Ink re-wraps a squeezed
  // `<Text>` rather than clipping it — the trap
  // `MouseTargetProps.flexShrink` warns about, one row away from here.
  const ground = ` ${label}`.padEnd(Math.max(0, groundWidth - CLOSE_COLUMNS));
  return (
    <Box width={inner} flexShrink={0}>
      <Text>{" ".repeat(ROW_MARGIN_COLUMNS)}</Text>
      <Box flexShrink={0} width={Math.max(0, groundWidth - CLOSE_COLUMNS)}>
        <Text
          color={theme.colors.railForeground}
          bold={selected || current}
          wrap="truncate"
          {...(selected ? { inverse: true } : {})}
        >
          {ground}
        </Text>
      </Box>
      {selected ? (
        <CloseSessionButton entry={entry} />
      ) : (
        <Text>{" ".repeat(CLOSE_COLUMNS)}</Text>
      )}
      <Text>{" ".repeat(ROW_MARGIN_COLUMNS)}</Text>
    </Box>
  );
}

/** Air either side of a rail list row's ground. */
const ROW_MARGIN_COLUMNS = 1;
/** Cells the close affordance occupies inside the ground: `[x]` + a pad. */
const CLOSE_COLUMNS = 4;

/**
 * The `x` at the right edge of the selected session's ground. It opens
 * the confirmation rather than deleting: this is one click away from
 * losing a thread, and the rail is a place people click while looking
 * somewhere else.
 */
function CloseSessionButton({
  entry,
}: {
  entry: SessionPickerEntry;
}): ReactElement {
  const mouse = useMouseCommands();
  // `[x]`, the same mark the design uses. It sits inside the row's
  // ground, so it carries the same inverse video as the label.
  const glyph = (
    <Text color={theme.colors.railForeground} bold inverse>
      {"[x] "}
    </Text>
  );
  if (!mouse) return glyph;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_BASE}
      flexShrink={0}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        mouse.dispatch({
          type: "session_delete_requested",
          sessionId: entry.sessionId,
          preview: entry.preview,
        });
        return true;
      }}
    >
      {glyph}
    </MouseTarget>
  );
}

/**
 * A rail list row: an optional 1-cell accent bar, then the label on an
 * optional filled ground.
 *
 * The design draws the bar as a 3px rule down the left edge of the row
 * and the selection as a translucent fill. Neither has a sub-cell
 * equivalent, so the bar is `▎` in the accent colour and the fill is a
 * real background on the label — the two marks the design uses, at the
 * resolution a terminal has.
 */
function RailRow({
  inner,
  children,
  bar,
  filled,
  bold,
  color,
}: {
  inner: number;
  children: string;
  bar?: boolean;
  filled?: boolean;
  bold?: boolean;
  color?: string;
}): ReactElement {
  const label = clip(children, Math.max(0, inner - 2));
  // One column of chrome, three states. The cursor keeps a glyph rather
  // than relying on the fill alone: the fill is a colour, and a colour
  // is nothing under NO_COLOR, in a pipe, or in the test renderer — the
  // one mark that says "Enter opens this row" has to survive all three.
  const mark = filled ? theme.glyphs.chevronRight : bar ? "▎" : " ";
  return (
    <Box width={inner} flexShrink={0}>
      <Text color={theme.colors.railAccent} bold>
        {mark}
      </Text>
      <Text
        color={color ?? theme.colors.railForeground}
        bold={bold ?? false}
        wrap="truncate"
        {...(filled ? { inverse: true } : {})}
      >
        {` ${label} `}
      </Text>
    </Box>
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
  const badge = statusBadge(row);
  return (
    <RailRow
      inner={inner}
      // A running task earns the bar for the same reason the current
      // session does: it is the row that is live, not the row the cursor
      // happens to sit on.
      bar={row.status === "running"}
      filled={selected}
      bold={selected}
    >
      {`${badge} ${preview}`}
    </RailRow>
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
