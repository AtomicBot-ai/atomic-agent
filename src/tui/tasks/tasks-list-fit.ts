import type { TaskSummaryRow } from "./tasks-panel-state.js";
import { formatRelativeMs } from "./tasks-summary.js";

/**
 * Fit maths for the Tasks list — how wide each column may be, which
 * footer hints survive, and how many rows the table may draw.
 *
 * The table used to lay out its columns from constants that added up to
 * ~123 characters no matter how wide the panel actually was. That was
 * survivable while the debug pane owned the full terminal; once the
 * left rail became permanent app frame the panel only gets
 * `computeChatWidth()` columns (88 on a 120-column terminal, 73 on a
 * 100-column one), so every row wrapped onto a second line — which
 * collided the columns into each other (`pendincron: 0 1 * * *`) and
 * silently doubled the height of the table. Ink 7 does not clip an
 * over-tall frame, it paints later lines over earlier ones (see
 * `../row-window.ts`), so the doubled height then overwrote the filter
 * bar and the header row with task text and diagnostics fragments.
 *
 * The height side is the same story from the other axis: the list used
 * to treat its whole row budget as *table rows* and then draw a header,
 * two scroll markers and a hint strip on top of it, so even with
 * one-line rows the panel asked for ~5 rows more than the debug pane
 * had budgeted — and those 5 rows are what Ink paints over the top of
 * the filter bar.
 *
 * All of that is geometry, not rendering, so it lives here as pure
 * functions: the component asks for a layout and renders it, and the
 * invariants — a row never exceeds the panel width, a frame never
 * exceeds its row budget — can be unit-tested as a table instead of
 * through screenshots.
 */

/** Chevron gutter in front of every row: the glyph plus one space. */
const CHEVRON_COLUMNS = 2;
/** Single space between two columns. */
const COLUMN_GAP = 1;
/**
 * One spare column held back from the row. Ink wraps a row whose
 * content matches the box width exactly as soon as anything (a
 * double-width glyph in a message, a padding change upstream) costs one
 * more cell than we predicted, and a wrapped row is the very failure
 * this module exists to prevent — so we buy the insurance.
 */
const SAFETY_COLUMNS = 1;

/** Widest `TaskStatus` string (`cancelled`). */
const STATUS_WIDTH = 9;
/** Narrowest status that still separates `pending` from `completed`. */
const STATUS_MIN_WIDTH = 4;
const SCHEDULE_WIDTH = 22;
const SCHEDULE_MIN_WIDTH = 12;
const NEXT_RUN_WIDTH = 9;
const NEXT_RUN_MIN_WIDTH = 7;
const SESSION_WIDTH = 10;
/** Below this the message column stops carrying any information. */
const MESSAGE_MIN_WIDTH = 16;

/**
 * Column widths for one table row, in characters. `0` means the column
 * is dropped entirely (no cell, no separating gap).
 */
export interface TaskListLayout {
  status: number;
  schedule: number;
  nextRun: number;
  session: number;
  message: number;
}

type MutableLayout = { -readonly [K in keyof TaskListLayout]: number };

/**
 * Order in which columns give up room when the panel is too narrow for
 * all of them. The message is what identifies a task to a human, so it
 * is defended to `MESSAGE_MIN_WIDTH` while everything else shrinks; the
 * session id goes early because it is only ever a truncated prefix here
 * and the detail view prints it in full.
 */
const DEGRADATIONS: ReadonlyArray<(layout: MutableLayout) => void> = [
  (layout) => {
    layout.schedule = SCHEDULE_MIN_WIDTH;
  },
  (layout) => {
    layout.session = 0;
  },
  (layout) => {
    layout.nextRun = NEXT_RUN_MIN_WIDTH;
  },
  (layout) => {
    layout.schedule = 0;
  },
  (layout) => {
    layout.nextRun = 0;
  },
  (layout) => {
    layout.status = STATUS_MIN_WIDTH;
  },
];

/** Width a laid-out row occupies, including the chevron and every gap. */
export function taskRowWidth(layout: TaskListLayout): number {
  return (
    CHEVRON_COLUMNS +
    layout.status +
    cellWidth(layout.schedule) +
    cellWidth(layout.nextRun) +
    cellWidth(layout.session) +
    cellWidth(layout.message)
  );
}

function cellWidth(width: number): number {
  return width > 0 ? width + COLUMN_GAP : 0;
}

/**
 * Resolve the column widths for a panel `width` columns wide. The
 * result always satisfies `taskRowWidth(layout) <= width`, which is
 * what keeps a row on one line.
 */
export function computeTaskListLayout(width: number): TaskListLayout {
  const usable = Math.max(0, Math.floor(width) - SAFETY_COLUMNS);
  const layout: MutableLayout = {
    status: STATUS_WIDTH,
    schedule: SCHEDULE_WIDTH,
    nextRun: NEXT_RUN_WIDTH,
    session: SESSION_WIDTH,
    message: MESSAGE_MIN_WIDTH,
  };
  for (const degrade of DEGRADATIONS) {
    if (taskRowWidth(layout) <= usable) break;
    degrade(layout);
  }
  // Whatever survives the degradations goes to the message: a wide
  // terminal should spend its extra columns on the prompt text, not on
  // padding between fixed-width cells.
  const slack = usable - taskRowWidth(layout);
  if (slack > 0) layout.message += slack;
  if (taskRowWidth(layout) > usable) {
    layout.message = Math.max(
      0,
      layout.message - (taskRowWidth(layout) - usable),
    );
  }
  if (taskRowWidth(layout) > usable) {
    // Nothing but the status fits. Still better than a wrapped row:
    // the operator can read the table's shape and widen the window.
    layout.schedule = 0;
    layout.nextRun = 0;
    layout.session = 0;
    layout.message = 0;
    layout.status = Math.max(1, usable - CHEVRON_COLUMNS);
  }
  return layout;
}

/** Text of one rendered cell, already padded / truncated to its width. */
export interface TaskRowCells {
  status: string;
  /** Columns after the chevron+status pair, in render order. Empty when dropped. */
  schedule: string;
  nextRun: string;
  session: string;
  message: string;
}

/**
 * Project a summary row onto a layout. Every cell comes back at exactly
 * its column width (the message is only truncated — trailing padding on
 * the last column buys nothing), so the header and the rows below it
 * can never drift apart.
 */
export function formatTaskRowCells(
  row: TaskSummaryRow,
  layout: TaskListLayout,
  now: number,
): TaskRowCells {
  return {
    status: padCell(row.status, layout.status),
    schedule: padCell(row.scheduleLabel, layout.schedule),
    nextRun: padCell(formatRelativeMs(row.scheduledFor, now), layout.nextRun),
    session: padCell(row.sessionId ?? "—", layout.session),
    message: truncate(row.userMessage, layout.message),
  };
}

/**
 * Header labels for a layout. Built from the same widths as the rows so
 * the column titles always sit over their own data — the old header was
 * a hand-spaced string literal, which stopped lining up the first time
 * anyone touched a column width.
 */
export function formatTaskListHeader(layout: TaskListLayout): string {
  const cells = [
    " ".repeat(CHEVRON_COLUMNS) + padCell("status", layout.status),
    padCell("schedule", layout.schedule),
    padCell("next-run", layout.nextRun),
    padCell("session", layout.session),
    truncate("message", layout.message),
  ].filter((cell) => cell.length > 0);
  return cells.join(" ".repeat(COLUMN_GAP)).trimEnd();
}

function padCell(text: string, width: number): string {
  if (width <= 0) return "";
  return truncate(text, width).padEnd(width);
}

function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return "…";
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Footer hints in priority order. The tail is dropped first when the
 * panel is too narrow to spell all of them, so the keys that let a
 * newcomer *do* something (move, open, create, cancel, run) have to
 * come before the ones that only adjust the view.
 */
export const TASK_LIST_HINTS: readonly string[] = [
  "j/k move",
  "Enter detail",
  "n new",
  "c cancel",
  "R run-now",
  "f filter",
  "/ search",
  "r refresh",
  "a auto",
  "Esc clear search",
];

const HINT_SEPARATOR = " · ";

/**
 * Longest prefix of `TASK_LIST_HINTS` that fits on one line. One line
 * is the point: the hint strip used to wrap onto a second row that the
 * height budget had not reserved, which is one of the rows that pushed
 * the panel over its budget and into Ink's overpainting.
 */
export function fitTaskListHints(width: number): string {
  const usable = Math.max(0, Math.floor(width) - SAFETY_COLUMNS);
  let line = "";
  for (const hint of TASK_LIST_HINTS) {
    const next = line.length === 0 ? hint : `${line}${HINT_SEPARATOR}${hint}`;
    if (next.length > usable) break;
    line = next;
  }
  // Even a panel too narrow for the first hint gets *something*: a
  // truncated `j/k move` still says the list is navigable.
  if (line.length === 0) return truncate(TASK_LIST_HINTS[0] ?? "", usable);
  return line;
}
/** How the list spends a row budget across its chrome and its rows. */
export interface TasksListFit {
  /** Rows the table body may draw. */
  listRows: number;
  /** Whether the column-header row is drawn. */
  header: boolean;
  /** Whether the footer hint strip is drawn. */
  hints: boolean;
  /** Whether a blank row separates the table from the hints. */
  hintsSpacer: boolean;
  /** Rows reserved for the `↑ N above` / `↓ N below` markers. */
  scrollMarkerRows: number;
}

/**
 * Rows the table keeps before it starts shedding chrome. Below three
 * the list stops being a list, so the header and then the hints go
 * first — a garbled panel helps nobody, but neither does a header with
 * a single row under it.
 */
const MIN_LIST_ROWS = 3;

/**
 * Chrome combinations in the order they are given up. Everything is
 * kept while it fits; then the blank spacer, then the hints, then the
 * header.
 */
const CHROME_LADDER: ReadonlyArray<
  Pick<TasksListFit, "header" | "hints" | "hintsSpacer">
> = [
  { header: true, hints: true, hintsSpacer: true },
  { header: true, hints: true, hintsSpacer: false },
  { header: true, hints: false, hintsSpacer: false },
  { header: false, hints: false, hintsSpacer: false },
];

/**
 * Split `budget` rows between the table's chrome and its body so the
 * rendered frame is never taller than the budget. `totalRows` is the
 * number of rows the filter currently matches — it decides whether the
 * scroll markers need reserving at all.
 */
export function computeTasksListFit(
  budget: number,
  totalRows: number,
): TasksListFit {
  const rows = Math.max(1, Math.floor(budget));
  for (const [index, chrome] of CHROME_LADDER.entries()) {
    const cost =
      (chrome.header ? 1 : 0) +
      (chrome.hints ? 1 : 0) +
      (chrome.hintsSpacer ? 1 : 0);
    const listRows = rows - cost;
    const last = index === CHROME_LADDER.length - 1;
    if (listRows >= MIN_LIST_ROWS || last) {
      return withScrollMarkers(chrome, listRows, totalRows);
    }
  }
  /* c8 ignore next 2 -- the ladder's last entry always returns above */
  return withScrollMarkers(
    { header: false, hints: false, hintsSpacer: false },
    rows,
    totalRows,
  );
}

/**
 * Reserve both marker rows as soon as the table cannot show everything.
 * Reserving lazily (only for the marker that is on screen right now)
 * overflows by one row the moment the cursor scrolls far enough for the
 * second marker to appear, and one row is all Ink needs to overpaint.
 */
function withScrollMarkers(
  chrome: Pick<TasksListFit, "header" | "hints" | "hintsSpacer">,
  listRows: number,
  totalRows: number,
): TasksListFit {
  const available = Math.max(1, listRows);
  const markers =
    totalRows > available ? Math.min(2, Math.max(0, available - 1)) : 0;
  return {
    ...chrome,
    scrollMarkerRows: markers,
    listRows: Math.max(1, available - markers),
  };
}
