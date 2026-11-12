/**
 * Which finalised chat messages the log has to draw (ATO-650).
 *
 * The log is bottom-anchored: row 0 is the last row above the composer
 * and `offset` is how many rows the operator has scrolled up from there
 * (`TuiState.chatScrollOffset`). Under the finalised messages sit the
 * live rows that are always drawn (streaming tail, pending steers, the
 * spinner); `bottomRows` is their height.
 *
 * Message `i` covers the rows, counted up from the bottom,
 * `[bottomRows + below(i), bottomRows + below(i) + heights[i])` where
 * `below(i)` is the sum of the heights after it. The viewport shows
 * `[offset, offset + viewportRows)`. Every message that intersects that
 * band widened by `overscanRows` on both sides is drawn; the ones above
 * and below it are replaced by blank spacers of the same total height,
 * so the column keeps its full height, the scroll clamp still sees the
 * whole chat, and the drawn rows land on exactly the cells they would
 * have had with everything rendered.
 *
 * Pure: no React, no Ink. `heights` come from measurement where a
 * message has been drawn before and from `estimateMessageHeight`
 * otherwise; overscan absorbs the estimate's error for the one frame
 * before the measurement lands.
 */

export interface ChatWindowInput {
  /** Rows of each finalised message, oldest first. */
  readonly heights: readonly number[];
  /** Rows always drawn under the finalised messages. */
  readonly bottomRows: number;
  /** Rows scrolled up from the bottom; 0 is pinned to the newest row. */
  readonly offset: number;
  /** Rows of the visible chat viewport. */
  readonly viewportRows: number;
  /** Extra rows drawn past each edge of the viewport. */
  readonly overscanRows: number;
}

export interface ChatWindow {
  /** First drawn message index. */
  readonly start: number;
  /** One past the last drawn message index; `start === end` draws none. */
  readonly end: number;
  /** Rows of the messages before `start`, drawn as a blank spacer. */
  readonly spacerAbove: number;
  /** Rows of the messages from `end` on, drawn as a blank spacer. */
  readonly spacerBelow: number;
  /** Rows of every finalised message plus `bottomRows`. */
  readonly totalRows: number;
}

/** Overscan floor, for viewports so short a screen of overscan is nothing. */
export const MIN_OVERSCAN_ROWS = 8;

/**
 * One viewport of overscan on each side: a wheel burst or a page jump
 * lands on rows that are already drawn and measured.
 */
export function chatOverscanRows(viewportRows: number): number {
  return Math.max(MIN_OVERSCAN_ROWS, rows(viewportRows));
}

export function computeChatWindow(input: ChatWindowInput): ChatWindow {
  const heights = input.heights.map(rows);
  const bottomRows = rows(input.bottomRows);
  const count = heights.length;
  const messageRows = heights.reduce((acc, h) => acc + h, 0);
  const totalRows = messageRows + bottomRows;
  if (count === 0) {
    return { start: 0, end: 0, spacerAbove: 0, spacerBelow: 0, totalRows };
  }
  const overscan = rows(input.overscanRows);
  const bandLow = rows(input.offset) - overscan;
  const bandHigh = rows(input.offset) + rows(input.viewportRows) + overscan;

  // Walk newest to oldest, tracking where each message starts counted
  // up from the bottom of the log.
  let start = count;
  let end = count;
  let fromBottom = bottomRows;
  let found = false;
  for (let i = count - 1; i >= 0; i -= 1) {
    const low = fromBottom;
    const high = fromBottom + heights[i]!;
    fromBottom = high;
    const intersects = high > bandLow && low < bandHigh;
    if (intersects) {
      if (!found) {
        end = i + 1;
        found = true;
      }
      start = i;
    } else if (found) {
      break;
    }
  }
  if (!found) {
    // The band sits entirely inside the live rows, or above the top of
    // a chat the caller has not clamped yet. Nothing to draw; keep the
    // full height in one spacer on the side the band missed.
    if (bandHigh <= bottomRows) {
      return {
        start: count,
        end: count,
        spacerAbove: messageRows,
        spacerBelow: 0,
        totalRows,
      };
    }
    return {
      start: 0,
      end: 0,
      spacerAbove: 0,
      spacerBelow: messageRows,
      totalRows,
    };
  }
  const spacerAbove = sum(heights, 0, start);
  const spacerBelow = sum(heights, end, count);
  return { start, end, spacerAbove, spacerBelow, totalRows };
}

function sum(values: readonly number[], from: number, to: number): number {
  let acc = 0;
  for (let i = from; i < to; i += 1) acc += values[i]!;
  return acc;
}

/** A row count: finite, whole and not negative. */
function rows(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
