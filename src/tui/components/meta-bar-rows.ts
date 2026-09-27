/**
 * How many rows the composer's meta bar takes, decided before Yoga lays
 * it out.
 *
 * The bar is inside an overlay that is bottom-anchored and grows
 * *upward*, so nothing stops it getting taller — but `ComposerSlot` has
 * to reserve the exact height it will paint, or the transcript either
 * loses its bottom rows behind the composer or gains a permanent blank
 * stripe above it (the trap `composer-overlay.tsx` documents). Ink has
 * no measurement pass, so the height is computed from the content's
 * widths and the render is then *clamped* to the number computed here.
 * That clamp is what makes the two agree by construction rather than by
 * care: the plan cannot be wrong about the height, only about whether
 * the height was generous enough.
 *
 * Every width fed in comes from the component that paints it —
 * `composerRouteWidth`, `contextChipLabel`, `codingModeChipLabel` — so
 * there is one string per readout, measured and rendered by the same
 * code.
 */

/** The label the stacked composition puts above the mode chip. */
export const MODE_STACK_LABEL = "Coding mode:";

/** Columns of the ` · ` between the left slot and the route. */
const LEAD_WIDTH = 3;

/**
 * Rows the bar may spend on content above its one-row baseline.
 *
 * Two: the stacked composition wants one (route above gauge), and a
 * route too long for a full line of its own wants the second. A third
 * would be a route wrapped three times, which at these widths means a
 * model name nobody configured on purpose — past that the bar clips,
 * which is what it did at every width before.
 */
export const MAX_META_EXTRA_ROWS = 2;

/**
 * Rows the window must have before the bar may spend one on a second
 * line. Unchanged from the threshold the one-row/stacked switch already
 * used, and for the same reason it was measured: the second line comes
 * out of the chat, and on a short window that is the worse trade — a
 * truncated provider name is a nuisance, a chat two replies shorter is
 * the app. It also keeps every classic 24-row terminal on the single-row
 * bar it was laid out for.
 */
export const META_STACK_MIN_ROWS = 30;

export interface MetaBarParts {
  /**
   * The bar's own inner width: the composer's frame and its horizontal
   * padding already taken off. Not the terminal's width — the rail and
   * the frame cost about forty columns between them.
   */
  readonly barColumns: number;
  /** Terminal height; the row budget is bought from it. */
  readonly terminalRows: number;
  /** `● cloud · anthropic · claude-opus-5`, via `composerRouteWidth`. */
  readonly routeWidth: number;
  /** The left slot: a composer notice, or the provider-outage readout. */
  readonly noticeWidth: number;
  /** The context gauge, via `contextChipLabel`. */
  readonly contextWidth: number;
  /** The coding-mode chip, via `codingModeChipLabel`. */
  readonly modeWidth: number;
}

export interface MetaBarPlan {
  /** Content rows, NOT counting the bar's padding row above and below. */
  readonly rows: number;
  /** Two columns: route above gauge on the left, mode on the right. */
  readonly stacked: boolean;
  /** Columns the left column gets, which is what the route wraps inside. */
  readonly leftColumns: number;
  /**
   * How many of {@link rows} belong to the route. Always at least one,
   * and never so many that the gauge below it loses its own — a route
   * allowed to take the whole column pushed the gauge out of the
   * clipped box entirely, which is how the fusion pair's second leg went
   * missing at 64 columns.
   */
  readonly routeRows: number;
}

/** Rows of bar content the window can afford. */
export function computeMetaRowBudget(terminalRows: number): number {
  if (terminalRows < META_STACK_MIN_ROWS) return 1;
  return 1 + MAX_META_EXTRA_ROWS;
}

/**
 * Decide the bar's composition and its height.
 *
 * The switch to the two-column form used to be `columns < 120`, a
 * number picked by measuring where a *typical* route stopped fitting.
 * It is now the question that number was standing in for: does this
 * route, beside these readouts, fit on one line? A 200-column terminal
 * with a Fusion pair and a full gauge gets the stacked form it needs,
 * and a 90-column one showing `local · llama.cpp` keeps the single row
 * it always had.
 */
export function planMetaBar(parts: MetaBarParts): MetaBarPlan {
  const {
    barColumns,
    terminalRows,
    routeWidth,
    noticeWidth,
    contextWidth,
    modeWidth,
  } = parts;
  const oneRow = (leftColumns: number): MetaBarPlan => ({
    rows: 1,
    stacked: false,
    leftColumns,
    routeRows: 1,
  });
  if (barColumns <= 0) return oneRow(0);

  const lead = noticeWidth > 0 && routeWidth > 0 ? LEAD_WIDTH : 0;
  const leftWidth = noticeWidth + lead + routeWidth;
  // `marginLeft={1}` separates the mode chip from the gauge beside it.
  const rightWidth = contextWidth + (modeWidth > 0 ? modeWidth + 1 : 0);

  if (leftWidth + rightWidth <= barColumns) {
    return oneRow(Math.max(0, barColumns - rightWidth));
  }
  // Nothing to spend: the single row clips, exactly as it always did.
  const budget = computeMetaRowBudget(terminalRows);
  if (budget <= 1) return oneRow(Math.max(0, barColumns - rightWidth));

  // Stacked. The right column is as wide as the wider of its two rows,
  // plus the margin; the left column takes the rest and the route wraps
  // inside it.
  const modeColumn =
    modeWidth > 0 ? Math.max(modeWidth, MODE_STACK_LABEL.length) + 1 : 0;
  const leftColumns = Math.max(1, barColumns - modeColumn);
  const gaugeRows = rowsFor(contextWidth, leftColumns);
  const wantedRouteRows = rowsFor(leftWidth, leftColumns);
  const rightRows = modeWidth > 0 ? 2 : 0;
  const wanted = Math.max(1, wantedRouteRows + gaugeRows, rightRows);
  const rows = Math.min(budget, wanted);
  // The gauge keeps its row inside the clipped column, so what is left
  // over is the route's. Capped by what the route actually wants: a
  // two-row bar carrying a one-line route and no gauge must not hand the
  // route a second line it has nothing to put on.
  const routeRows = Math.max(1, Math.min(wantedRouteRows, rows - gaugeRows));
  return { rows, stacked: true, leftColumns, routeRows };
}

/** Lines `width` columns of content take inside `columns`. */
function rowsFor(width: number, columns: number): number {
  if (width <= 0) return 0;
  return Math.max(1, Math.ceil(width / Math.max(1, columns)));
}
