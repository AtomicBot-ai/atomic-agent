/**
 * Cursor-aware list windowing shared by the debug/manage panels.
 *
 * Ink cannot reliably clip a frame taller than the terminal — when the
 * rendered height exceeds `process.stdout.rows` the redraw cursor math
 * drifts and earlier lines overlap later ones (the "garbled panel"
 * symptom on small windows). Panels therefore render only a slice of
 * their list that fits the available height, keeping the selected row in
 * view and surfacing how many rows are hidden above / below.
 */

export interface RowWindow {
  /** Index of the first visible row in the source list. */
  start: number;
  /** Number of rows in the visible slice (<= maxRows). */
  count: number;
  /** Rows hidden above the slice (0 when the head is visible). */
  hiddenBefore: number;
  /** Rows hidden below the slice (0 when the tail is visible). */
  hiddenAfter: number;
}

/**
 * Resolve the first visible index so the `cursor` row stays on screen.
 * Mirrors the long-standing `computeWindowStart` used by the skills /
 * tasks / memory list components.
 */
export function computeWindowStart(
  cursor: number,
  total: number,
  size: number,
): number {
  if (size <= 0) return 0;
  if (total <= size) return 0;
  if (cursor < size) return 0;
  return Math.min(cursor - size + 1, total - size);
}

/**
 * Compute the visible window for a list of `total` rows given the active
 * `cursor` and a `maxRows` budget. `maxRows` is clamped to at least 1 so
 * callers passing a degenerate budget still get a usable slice.
 */
export function computeRowWindow(
  total: number,
  cursor: number,
  maxRows: number,
): RowWindow {
  const size = Math.max(1, Math.floor(maxRows));
  if (total <= 0) {
    return { start: 0, count: 0, hiddenBefore: 0, hiddenAfter: 0 };
  }
  const clampedCursor = Math.max(0, Math.min(cursor, total - 1));
  const start = computeWindowStart(clampedCursor, total, size);
  const count = Math.min(size, total - start);
  return {
    start,
    count,
    hiddenBefore: start,
    hiddenAfter: Math.max(0, total - start - count),
  };
}
