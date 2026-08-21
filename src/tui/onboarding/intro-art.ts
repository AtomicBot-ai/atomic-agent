import { CELL_ASPECT, computeOrbitField } from "./orbit-field.js";

/** Blank rows and columns kept between the mark's box and the ring. */
const RING_GAP_ROWS = 2;
const RING_GAP_COLUMNS = 4;

/** The glyph the ring is drawn with — the mark, shrunk past legibility. */
export const ORBIT_GLYPH = "✛";

export interface IntroArtOptions {
  /** Usable width in cells. */
  columns: number;
  /** The mark, as its own rows. */
  markRows: readonly string[];
  /** How many crosses to place on the ring. Zero draws the mark alone. */
  crossCount: number;
  /**
   * Rows the art block may occupy, mark included. The ring is sized to
   * fit inside it — Ink 7 overlaps rather than clips, so art that
   * outgrows its budget does not get cropped, it eats the rows above.
   */
  rows: number;
}

/**
 * The intro's art block: the mark centred, with the cross ring around
 * it, as one grid of rows.
 *
 * Composed into a character grid rather than layered with absolutely
 * positioned boxes because the ring has to *interleave* with the mark's
 * rows — and because a grid is a value a test can read, while an Ink
 * layout is only a rendered frame.
 */
export function buildIntroArt(options: IntroArtOptions): string[] {
  const { columns, markRows, crossCount } = options;
  const markWidth = markRows.reduce((max, row) => Math.max(max, row.length), 0);
  // The ring is sized by whichever runs out first — the rows it is
  // allowed to use, or the columns. Sizing it to the mark and hoping it
  // fits clips its top and bottom arcs and leaves crosses down the sides
  // only; sizing it to the columns alone pushes the wordmark off screen.
  // No padding when the budget is already smaller than the mark: the
  // grid must never come out taller than it was allowed to be, and a
  // ring with nowhere to sit is dropped below anyway.
  const ringPadRows =
    crossCount > 0 ? Math.max(0, Math.floor((options.rows - markRows.length) / 2)) : 0;
  const height = markRows.length + ringPadRows * 2;
  const verticalRadius = Math.max(0, height / 2 - 1);
  const requested =
    crossCount > 0
      ? Math.min(verticalRadius * CELL_ASPECT, Math.floor(columns / 2) - 2)
      : 0;
  // Clearance is checked per axis, against the mark's own box. A single
  // radius threshold cannot express it: the ring is an ellipse and the
  // mark is wider than it is tall, so one number is either too strict
  // vertically or too loose horizontally — the first draft was the
  // former and silently dropped the ring at 100×30, where it fits with
  // room to spare. A cross resting against an arm reads as a glitch in
  // the logo, so when either axis is short the ring is dropped whole.
  const clearsRows = verticalRadius >= markRows.length / 2 + RING_GAP_ROWS;
  const clearsColumns = requested >= markWidth / 2 + RING_GAP_COLUMNS;
  const radius = clearsRows && clearsColumns ? requested : 0;
  const grid: string[][] = Array.from({ length: height }, () =>
    Array.from({ length: columns }, () => " "),
  );
  const markLeft = Math.max(0, Math.floor((columns - markWidth) / 2));
  const markTop = ringPadRows;
  for (const [rowIndex, row] of markRows.entries()) {
    for (const [colIndex, glyph] of [...row].entries()) {
      if (glyph === " ") continue;
      const y = markTop + rowIndex;
      const x = markLeft + colIndex;
      if (y < 0 || y >= height || x < 0 || x >= columns) continue;
      grid[y]![x] = glyph;
    }
  }
  const center = {
    column: markLeft + Math.floor(markWidth / 2),
    row: markTop + Math.floor(markRows.length / 2),
  };
  const cells = computeOrbitField({
    columns,
    rows: height,
    center,
    radius,
    count: crossCount,
    phase: Math.PI / 12,
  });
  for (const cell of cells) {
    if (grid[cell.row]?.[cell.column] !== " ") continue;
    grid[cell.row]![cell.column] = ORBIT_GLYPH;
  }
  return grid.map((row) => row.join("").replace(/\s+$/u, ""));
}
