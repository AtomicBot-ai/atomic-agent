import { computeMarkClearSpans } from "./mark-clear-space.js";
import { CELL_ASPECT } from "./orbit-field.js";
import { computeStarField } from "./star-field.js";
import { STAR_GLYPHS } from "./star-tiers.js";

/** Blank rows and columns kept between the mark's ink and the nearest star. */
const CLEAR_GAP_ROWS = 2;
const CLEAR_GAP_COLUMNS = 4;

export interface IntroArtOptions {
  /** Usable width in cells. */
  columns: number;
  /** The mark, as its own rows. */
  markRows: readonly string[];
  /**
   * Rows the art block may occupy, mark included. The sky is sized to
   * fit inside it — Ink 7 overlaps rather than clips, so art that
   * outgrows its budget does not get cropped, it eats the rows above.
   */
  rows: number;
  /** Multiplier on the sky's designed star density. Zero draws the mark alone. */
  density?: number;
  /** Stars in the arc that orbits the mark. Zero drops the arc. */
  haloCount?: number;
  /** Seed for the field, so one terminal size always paints one sky. */
  seed?: number;
}

/**
 * The intro's art block: the mark centred in a field of stars, as one
 * grid of rows.
 *
 * Composed into a character grid rather than layered with absolutely
 * positioned boxes because the sky has to *interleave* with the mark's
 * rows — and because a grid is a value a test can read, while an Ink
 * layout is only a rendered frame. Tier survives the flattening through
 * the glyph: each brightness has its own, and the renderer looks it back
 * up to choose a colour.
 */
export function buildIntroArt(options: IntroArtOptions): string[] {
  const { columns, markRows } = options;
  const density = options.density ?? 0;
  const haloCount = options.haloCount ?? 0;
  const markWidth = markRows.reduce((max, row) => Math.max(max, row.length), 0);
  // With a sky to draw, the block takes its whole budget and the mark is
  // centred in it; with nothing but the mark, padding would only push
  // the wordmark down. The odd row goes below the mark rather than being
  // dropped: splitting the slack evenly wastes a row whenever the mark's
  // height and the budget disagree in parity, and a row of sky is the
  // one thing this screen has too little of.
  const hasSky = density > 0 || haloCount > 0;
  const slack = hasSky ? Math.max(0, options.rows - markRows.length) : 0;
  const padTop = Math.floor(slack / 2);
  const height = markRows.length + slack;
  const grid: string[][] = Array.from({ length: height }, () =>
    Array.from({ length: columns }, () => " "),
  );
  const markLeft = Math.max(0, Math.floor((columns - markWidth) / 2));
  const markTop = padTop;
  for (const [rowIndex, row] of markRows.entries()) {
    for (const [colIndex, glyph] of [...row].entries()) {
      if (glyph === " ") continue;
      const y = markTop + rowIndex;
      const x = markLeft + colIndex;
      if (y < 0 || y >= height || x < 0 || x >= columns) continue;
      grid[y]![x] = glyph;
    }
  }
  const clearSpans = computeMarkClearSpans({
    markRows,
    top: markTop,
    left: markLeft,
    rows: height,
    gapRows: CLEAR_GAP_ROWS,
    gapColumns: CLEAR_GAP_COLUMNS,
  });
  const stars = computeStarField({
    columns,
    rows: height,
    clearSpans,
    density,
    seed: options.seed,
    halo: haloRing(options, { height, markWidth, markLeft, markTop }),
  });
  for (const star of stars) {
    if (grid[star.row]?.[star.column] !== " ") continue;
    grid[star.row]![star.column] = STAR_GLYPHS[star.tier];
  }
  return grid.map((row) => row.join("").replace(/\s+$/u, ""));
}

/**
 * The arc's spine, or undefined when it does not fit.
 *
 * Clearance is checked per axis, against the mark's own box. A single
 * radius threshold cannot express it: the arc is an ellipse and the mark
 * is wider than it is tall, so one number is either too strict
 * vertically or too loose horizontally — the first draft was the former
 * and silently dropped the arc at 100×30, where it fits with room to
 * spare. A star resting against an arm reads as a glitch in the logo, so
 * when either axis is short the arc is dropped whole and the sky is left
 * to carry the screen on its own.
 */
function haloRing(
  options: IntroArtOptions,
  box: { height: number; markWidth: number; markLeft: number; markTop: number },
): { center: { row: number; column: number }; radius: number; count: number } | undefined {
  const count = options.haloCount ?? 0;
  if (count <= 0) return undefined;
  const markHeight = options.markRows.length;
  const verticalRadius = Math.max(0, box.height / 2 - 1);
  const radius = Math.min(
    verticalRadius * CELL_ASPECT,
    Math.floor(options.columns / 2) - 2,
  );
  const clearsRows = verticalRadius >= markHeight / 2 + CLEAR_GAP_ROWS;
  const clearsColumns = radius >= box.markWidth / 2 + CLEAR_GAP_COLUMNS;
  if (!clearsRows || !clearsColumns) return undefined;
  return {
    center: {
      column: box.markLeft + Math.floor(box.markWidth / 2),
      row: box.markTop + Math.floor(markHeight / 2),
    },
    radius,
    count,
  };
}
