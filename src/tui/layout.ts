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
 * Rows the rail itself spends before a single list row is drawn. Since
 * the rail became the app frame it also carries the brand lockup, the
 * version line and the Menu button, on top of the two section headers,
 * the blank row between the panes and a "↓ N more" footer per pane.
 * The `+ new` control costs nothing: it sits on the Sessions header row
 * rather than on a line of its own; the blank row under the Menu button,
 * which lifts it off the rail's bottom edge, does cost one.
 * Counted off the rendered component rather
 * than estimated — the left border costs no rows because `sidebar.tsx`
 * turns the top and bottom edges off — and pinned by
 * `sidebar-fit.test.tsx`, which renders the rail at a budget and
 * asserts it comes to exactly `sessions + tasks + SIDEBAR_CHROME_ROWS`
 * rows. Two of these rows went back to the lists when the brand mark
 * dropped from five rows to three.
 */
export const SIDEBAR_CHROME_ROWS = 14;

/**
 * Rows the rail costs outside its own frame: the status bar above it
 * (one row at any width that carries the rail) plus one row of slack,
 * so the frame lands short of the terminal height rather than exactly
 * on it.
 */
const SIDEBAR_OUTER_ROWS = 2;

/** Everything the row budget has to leave alone. */
const SIDEBAR_RESERVED_ROWS = SIDEBAR_CHROME_ROWS + SIDEBAR_OUTER_ROWS;

/**
 * Shortest terminal that still fits the reserved rows plus one list
 * row in each pane. Below this the rail is not drawn at all: Ink 7
 * overlaps rather than clips (see `row-window.ts`), so a rail that
 * does not fit garbles the whole frame instead of losing its tail.
 */
export const SIDEBAR_MIN_ROWS = SIDEBAR_RESERVED_ROWS + 2;

/**
 * Rows of "chrome" outside the chat surface: status bar + the hairline
 * under it + prompt meta-row + prompt input + prompt tail-cap + hotkey
 * hint + a small safety pad. Used to convert `terminal.rows` into the
 * chat-area viewport height. Slightly conservative — better to leave one
 * empty row than to clip the prompt.
 *
 * The hairline under the status bar spends the row of slack this count
 * always carried rather than adding one: raising the number shrinks the
 * chat viewport, and at 24 rows that came straight out of the operator
 * menu, which sheds its own key-hint footer first. A second hairline
 * over the hint strip was drawn and then dropped for the same reason —
 * the composer's border already reads as the edge it would have drawn.
 */
export const CHROME_ROWS = 12;

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

/**
 * The smallest terminal the app will draw itself into.
 *
 * **Rows.** `CHROME_ROWS + MIN_VIEWPORT_ROWS`, which is not a
 * preference — it is the height the frame actually stops shrinking at.
 * Rendered against a mocked terminal size, the main screen comes out at
 * 16 rows for a 16-row terminal, and at 16 rows for a 14-, 12-, 8- and
 * 5-row one. The layout has nothing left to give below this; the chrome
 * is the status bar, the hairline, the composer's three rows, the meta
 * bar, the hint strip and the pad, and the viewport floor is four lines
 * of transcript.
 *
 * That matters more here than it would in a browser, because **Ink 7
 * does not clip a frame taller than the terminal — it overlaps earlier
 * lines**. A 16-row frame in a 10-row window is not a cropped UI, it is
 * six rows of two different UIs on top of each other, which is what
 * `layout.ts` and `splash-fit.ts` have been working around piecemeal.
 *
 * **Columns.** 40 is the narrowest width at which the composer's frame
 * (two border columns and two of padding) plus its `send →` chip still
 * leave room to see what you are typing. It is also the narrowest case
 * the splash's own fit tests already cover, so the two agree on where
 * "small" ends.
 *
 * Below either floor the app draws {@link TerminalTooSmall} instead of
 * itself — one short card that fits anything, says what is needed and
 * what it has, and repaints as the window is dragged.
 */
export const MIN_TERMINAL_COLUMNS = 40;
export const MIN_TERMINAL_ROWS = CHROME_ROWS + MIN_VIEWPORT_ROWS;

/**
 * True when the terminal cannot hold the app's own chrome.
 *
 * Deliberately not "…cannot hold it comfortably": every size at or above
 * this floor still gets the real UI, degraded by the rules the rest of
 * this module already encodes (the rail drops at 100 columns, the chrome
 * grows a row at 60). This is the line below which degrading further
 * stops producing a smaller UI and starts producing a broken one.
 */
export function isTerminalTooSmall(columns: number, rows: number): boolean {
  return columns < MIN_TERMINAL_COLUMNS || rows < MIN_TERMINAL_ROWS;
}

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

/**
 * Whether the terminal is both wide and tall enough to carry the right
 * rail. Height matters as much as width: a 100×8 split pane is wide
 * enough for the rail and far too short for it, and an over-tall rail
 * garbles the frame rather than being clipped.
 */
export function isSidebarVisible(columns: number, rows: number): boolean {
  return columns >= SIDEBAR_MIN_COLUMNS && rows >= SIDEBAR_MIN_ROWS;
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
export function computeChatWidth(columns: number, rows: number): number {
  const rail = isSidebarVisible(columns, rows)
    ? computeSidebarWidth(columns)
    : 0;
  return Math.max(0, columns - ROOT_PADDING_LEFT - rail);
}

/**
 * Split the rail's usable height between the Sessions and Tasks panes,
 * roughly 2:1 in favour of sessions, and stay under the caps that used
 * to be hard-coded in `sidebar.tsx`.
 *
 * Ink 7 does not clip a frame taller than the terminal — it overlaps
 * earlier lines (see `row-window.ts`) — so this budget is what keeps a
 * short window from garbling the rail. Nothing here floors the split
 * above what is actually available: `sessions + tasks` never exceeds
 * `usable`, and a window too short to seat one row in each pane is
 * handled by `isSidebarVisible` hiding the rail outright, not by
 * handing back a budget that does not fit.
 */
export function computeSidebarRowBudget(rows: number): SidebarRowBudget {
  const usable = Math.max(0, rows - SIDEBAR_RESERVED_ROWS);
  // Capping at `usable - 1` leaves the last row to Tasks, so its
  // header is never left dangling over an empty pane while sessions
  // still take the larger share of anything above two rows.
  const sessions = clamp(
    Math.min(Math.ceil((usable * 2) / 3), Math.max(1, usable - 1)),
    0,
    SIDEBAR_MAX_SESSION_ROWS,
  );
  const tasks = clamp(usable - sessions, 0, SIDEBAR_MAX_TASK_ROWS);
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
