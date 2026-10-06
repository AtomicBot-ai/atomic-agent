/**
 * Largest viewport any wizard pick list will use, and the jump distance
 * for PgUp/PgDn in `providers-wizard-key-bindings`. Keep the two in sync
 * by importing this constant, never by copying the number.
 *
 * The rendered viewport shrinks below this on short terminals (see
 * `pickWindowRows`); the paging distance deliberately does not. PgDn is
 * "go a screenful further down a 300-row catalog", and pinning it to a
 * 3-row window on an 80x24 terminal would turn it into ↓↓↓.
 */
export const PICK_WINDOW = 12;

/** Never shrink the viewport below this — one row is not a list. */
export const PICK_MIN_WINDOW = 3;

/**
 * Rows the box spends on things that are not options: two border lines,
 * the top and bottom margins, the title, and the hint.
 */
const PICK_CHROME_ROWS = 6;

/**
 * How many option rows fit in `maxRows` total rows of terminal.
 *
 * `undefined` means "no budget was passed" and keeps the historical
 * fixed viewport. Callers that know the budget must pass it: Ink 7 does
 * not clip a frame taller than the terminal, it paints later lines over
 * earlier ones, so a 16-row box on an 11-row budget does not lose its
 * bottom — it eats whatever was above it.
 */
export function pickWindowRows(
  maxRows: number | undefined,
  extraChromeRows = 0,
): number {
  // The fixed viewport pays for extra chrome too: the unbudgeted callers
  // (first-run onboarding, the Providers panel) sized their screens to a
  // 12-option box, so a search or error line that ADDED a row instead of
  // taking one pushed their bottom row off a 24-row terminal.
  if (maxRows === undefined) {
    return Math.max(PICK_MIN_WINDOW, PICK_WINDOW - extraChromeRows);
  }
  return Math.max(
    PICK_MIN_WINDOW,
    Math.min(PICK_WINDOW, maxRows - PICK_CHROME_ROWS - extraChromeRows),
  );
}
