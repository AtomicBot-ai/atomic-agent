import { describe, expect, it } from "vitest";

import {
  APP_CHROME_ROWS_BASE,
  appChromeRows,
  steppedPanelRendered,
  steppedPanelRows,
} from "./debug-pane.js";

/**
 * The LLM and Models panels collapse in two steps, not continuously: a
 * fixed short form up to 15 rows and a fixed tall form from 16. So the
 * budget they are handed is not a ceiling they respect — offer them 17
 * and they render 20. Ink 7 does not clip an over-tall frame; it paints
 * over the rows above, which on a default 80x24 terminal means the
 * status bar and the hairline get overwritten by panel content.
 *
 * Reclaiming the composer's rows on the Manage tabs walked straight into
 * that band, so those two panels keep the pre-reclaim budget. This sweep
 * is the guard.
 */
describe("stepped panel budget", () => {
  it("never offers the tall form more rows than the pane can hold", () => {
    // The band that bites: a budget of 16..19 flips the panel to its
    // 20-row form. That is only safe when the pane really has 20 rows.
    for (let rows = 18; rows <= 60; rows += 1) {
      const offered = steppedPanelRows(rows, false);
      const available = rows - appChromeRows(false) - 3 - 1;
      if (steppedPanelRendered(offered) === 20) {
        expect(
          available,
          `terminal ${rows} rows: tall panel (20) offered into ${available}`,
        ).toBeGreaterThanOrEqual(20);
      }
    }
  });

  it("never renders taller without the composer than with it", () => {
    // Reclaiming the composer's six rows must not make a screen worse
    // than it was when the composer was still taking them. (Panels that
    // already overflowed a very short terminal keep doing so — that is
    // an older bug, and this sweep pins that it is not made worse.)
    for (let rows = 18; rows <= 60; rows += 1) {
      const withComposer = steppedPanelRendered(steppedPanelRows(rows, true));
      const without = steppedPanelRendered(steppedPanelRows(rows, false));
      expect(without, `terminal ${rows} rows`).toBeLessThanOrEqual(withComposer);
    }
  });

  it("counts the composer's rows only when the composer is on screen", () => {
    expect(appChromeRows(false)).toBe(APP_CHROME_ROWS_BASE);
    expect(appChromeRows(true)).toBeGreaterThan(appChromeRows(false));
  });
});
