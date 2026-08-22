/**
 * Where the first-run content block sits inside the terminal.
 *
 * The setup screens centre a left-aligned block rather than each of its
 * lines. Centring the lines individually gives a ragged column of
 * options that is much harder to scan, and makes a row slide sideways
 * every time its text changes — a percentage ticking up would drag the
 * whole list with it. So the box moves and the lines inside it stay put,
 * which needs the box's measured width: `onboarding-surface-layout.ts`
 * supplies that, and this module turns it and the terminal size into the
 * three numbers the layout asks for.
 *
 * React-free so the arithmetic is tested as a table rather than through
 * rendered frames.
 */

export interface OnboardingBlockPlacement {
  /** `marginLeft` for the block, inside the root inset. */
  left: number;
  /** Width the block is given — never more room than it has. */
  width: number;
  /** Rows the block may draw into before the pinned hint strip. */
  rows: number;
}

export interface OnboardingBlockPlacementInput {
  /** Full terminal width. The block is balanced against the window. */
  columns: number;
  /** Full terminal height. */
  rows: number;
  /** Widest line the current step draws. */
  blockWidth: number;
  /** Columns the TUI root already spends on its left inset. */
  paddingLeft: number;
  /** Rows the surface spends above the block. */
  paddingTop: number;
  /** Rows the pinned hint strip owns on the last line. */
  footerRows: number;
}

export function placeOnboardingBlock(
  input: OnboardingBlockPlacementInput,
): OnboardingBlockPlacement {
  const room = Math.max(0, input.columns - input.paddingLeft);
  const width = Math.max(0, Math.min(input.blockWidth, room));
  // Balanced against the whole window and then pulled back by the root
  // inset, so the block reads as centred on the terminal rather than on
  // the padded box it happens to live in. Clamped at zero: a block wider
  // than the window starts at the left margin, where a negative margin
  // would instead shift it further off the left edge.
  const left = Math.max(
    0,
    Math.floor((input.columns - width) / 2) - input.paddingLeft,
  );
  const rows = Math.max(0, input.rows - input.paddingTop - input.footerRows);
  return { left, width, rows };
}

/**
 * Widest of the lines a step draws.
 *
 * Trailing spaces are trimmed first: rows are built with `padEnd` to
 * line their columns up, and those pad cells are invisible — counting
 * them would push the block left of where it looks centred.
 *
 * `length` rather than a display-width library, for the same reason
 * `hotkey-hint.ts` gives: every glyph on these screens is a
 * single-column BMP character, so the two agree and the dependency
 * would buy nothing.
 */
export function widestLine(lines: readonly string[]): number {
  return lines.reduce((widest, line) => Math.max(widest, line.trimEnd().length), 0);
}
