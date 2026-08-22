/**
 * The hole the star field leaves for the brand mark.
 *
 * Kept apart from the field itself: one module decides what the mark
 * owns, the other fills everything else. Pure, so the clearance can be
 * asserted as a table rather than by counting glyphs in a frame.
 */

import type { ClearSpan } from "./star-field.js";

export interface MarkClearSpaceOptions {
  markRows: readonly string[];
  /** Where the mark's first row and first column land on the canvas. */
  top: number;
  left: number;
  /** Canvas height, so the spans stop at its edges. */
  rows: number;
  /** Blank rows kept above and below the mark's ink. */
  gapRows: number;
  /** Blank columns kept either side of it. */
  gapColumns: number;
}

/**
 * One blocked span per canvas row: the columns the mark inks on that
 * row, widened by the gap on both axes.
 *
 * Per row rather than one bounding box because the mark is a cross. At
 * the size the flow actually opens at its box is nearly the whole
 * canvas, and reserving the box leaves the sky as two strips down the
 * sides; following the silhouette instead lets stars sit in the four
 * quadrants between the arms, which is what stops the mark looking
 * pasted onto the sky rather than in it.
 */
export function computeMarkClearSpans(options: MarkClearSpaceOptions): ClearSpan[] {
  const inked = options.markRows.map(inkedSpan);
  const spans: ClearSpan[] = [];
  for (let row = 0; row < options.rows; row += 1) {
    let from = Number.POSITIVE_INFINITY;
    let to = Number.NEGATIVE_INFINITY;
    for (const [index, span] of inked.entries()) {
      if (!span) continue;
      if (Math.abs(options.top + index - row) > options.gapRows) continue;
      from = Math.min(from, span.from);
      to = Math.max(to, span.to);
    }
    if (from > to) continue;
    spans.push({
      row,
      from: options.left + from - options.gapColumns,
      to: options.left + to + options.gapColumns,
    });
  }
  return spans;
}

/** First and last inked column of one mark row, or null when it is blank. */
function inkedSpan(row: string): { from: number; to: number } | null {
  const glyphs = [...row];
  const from = glyphs.findIndex((glyph) => glyph !== " ");
  if (from === -1) return null;
  let to = from;
  for (let index = glyphs.length - 1; index > from; index -= 1) {
    if (glyphs[index] !== " ") {
      to = index;
      break;
    }
  }
  return { from, to };
}
