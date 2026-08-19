/**
 * Shared terminal-geometry maths for the chat shell.
 *
 * Two components need to agree on how the terminal width is carved up:
 * `TuiApp` decides whether the right rail is drawn and how wide it is,
 * and `SplashBanner` has to know how much room is left for the brand
 * artwork. Keeping the arithmetic here means the splash can never
 * disagree with the rail about where the boundary sits.
 *
 * Nothing in this module touches React or `process.stdout` — callers
 * pass the size they already read via `useTerminalSize()`.
 */

/** `paddingLeft` on the TUI root box (`tui-app.tsx`). */
export const ROOT_PADDING_LEFT = 2;

/**
 * Minimum terminal width (in columns) at which the right-rail sidebar
 * is rendered. Narrower terminals collapse the layout back to the
 * single-column form so cramped sessions over SSH stay usable. Picked
 * to match opencode's threshold.
 */
export const SIDEBAR_MIN_COLUMNS = 100;

/** Narrowest rail that still fits a chevron, a badge and a preview. */
export const SIDEBAR_MIN_WIDTH = 24;
/** Widest rail — beyond this the previews stop gaining information. */
export const SIDEBAR_MAX_WIDTH = 34;
/** Share of the terminal the rail is allowed to claim. */
const SIDEBAR_WIDTH_RATIO = 0.25;

/**
 * Rows the rail spends on its own chrome before a single list row is
 * drawn: the status bar above it, the two section headers, the blank
 * row between the panes, a "↓ N more" footer per pane and one row of
 * slack.
 */
const SIDEBAR_CHROME_ROWS = 7;

/**
 * Rows of "chrome" outside the chat surface: status bar + prompt
 * meta-row + prompt input + prompt tail-cap + hotkey hint + a small
 * safety pad. Used to convert `terminal.rows` into the chat-area
 * viewport height. Slightly conservative — better to leave one empty
 * row than to clip the prompt.
 */
export const CHROME_ROWS = 8;

/**
 * Below this width the status bar, the hotkey hint strip and the prompt
 * placeholder all start wrapping onto extra lines, so the chat surface
 * gets less room than `CHROME_ROWS` alone would suggest. Measured
 * against the real TUI at 45 columns: the status bar takes 2 rows, the
 * hint strip 3, and the longer rotating placeholders push the prompt to
 * 2 — hence one row of slack on top of the three observed.
 */
const NARROW_COLUMNS = 60;
const NARROW_CHROME_EXTRA = 4;

/** Floor for the chat viewport — below this nothing readable survives. */
const MIN_VIEWPORT_ROWS = 4;

/** Row caps at which extra height stops buying useful context. */
const SIDEBAR_MAX_SESSION_ROWS = 10;
const SIDEBAR_MAX_TASK_ROWS = 5;

export interface SidebarRowBudget {
  sessions: number;
  tasks: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Whether the terminal is wide enough to carry the right rail. */
export function isSidebarVisible(columns: number): boolean {
  return columns >= SIDEBAR_MIN_COLUMNS;
}

/**
 * Rail width as a share of the terminal rather than a flat 30 columns.
 * A flat width left a 100-column terminal with only 70 columns of chat
 * — not enough for the full-size brand artwork — while a 200-column
 * terminal got a rail that looked stranded.
 */
export function computeSidebarWidth(columns: number): number {
  return clamp(
    Math.round(columns * SIDEBAR_WIDTH_RATIO),
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH,
  );
}

/**
 * Columns available to the chat column (and therefore to the splash)
 * once the root padding and the rail have taken their share.
 */
export function computeChatWidth(columns: number): number {
  const rail = isSidebarVisible(columns) ? computeSidebarWidth(columns) : 0;
  return Math.max(0, columns - ROOT_PADDING_LEFT - rail);
}

/**
 * Split the rail's usable height between the Sessions and Tasks panes,
 * roughly 2:1 in favour of sessions. Both panes keep at least one row
 * so neither header is ever left dangling over an empty pane, and both
 * stay under the caps that used to be hard-coded in `sidebar.tsx`.
 *
 * Ink 7 does not clip a frame taller than the terminal — it overlaps
 * earlier lines (see `row-window.ts`) — so this budget is what keeps a
 * short window from garbling the rail.
 */
export function computeSidebarRowBudget(rows: number): SidebarRowBudget {
  const usable = Math.max(2, rows - SIDEBAR_CHROME_ROWS);
  const sessions = clamp(
    Math.ceil((usable * 2) / 3),
    1,
    SIDEBAR_MAX_SESSION_ROWS,
  );
  const tasks = clamp(usable - sessions, 1, SIDEBAR_MAX_TASK_ROWS);
  return { sessions, tasks };
}

/**
 * Rows the chat surface actually gets once the status bar, prompt and
 * hint strip have taken theirs. Both `ChatLog` (scroll viewport) and
 * `SplashBanner` (fit budget) read the same number so the splash can
 * never plan for more rows than the surface it is rendered into.
 *
 * `columns` is optional so existing callers keep the wide-terminal
 * behaviour; pass it to get the narrow-terminal correction.
 */
export function computeChatViewportRows(
  rows: number,
  columns = Number.POSITIVE_INFINITY,
): number {
  const chrome =
    CHROME_ROWS + (columns < NARROW_COLUMNS ? NARROW_CHROME_EXTRA : 0);
  return Math.max(MIN_VIEWPORT_ROWS, rows - chrome);
}
