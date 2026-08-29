import { describe, expect, it } from "vitest";
import {
  computeSplashFit,
  LOGO_METRICS,
  SPLASH_TIPS,
  WORDMARK_STACK_ROWS,
  type LogoVariant,
} from "./splash-fit.js";

/** Rows the mark costs, stacked wordmark included. */
function markRows(fit: ReturnType<typeof computeSplashFit>): number {
  if (fit.logo === "none") return 0;
  return (
    LOGO_METRICS[fit.logo].height +
    (fit.wordmarkPlacement === "below" ? WORDMARK_STACK_ROWS : 0)
  );
}

const SIZE_ORDER: readonly LogoVariant[] = ["tiny", "mini", "small", "full"];

describe("computeSplashFit", () => {
  it("gives a very wide terminal the full artwork with the wordmark beside it", () => {
    // The mark is 51 columns, so a side-by-side lockup wants 100 inner
    // columns — roughly a 140-column terminal.
    expect(computeSplashFit({ columns: 108, rows: 44 })).toEqual({
      logo: "full",
      wordmarkPlacement: "beside",
      wordmark: true,
      tagline: true,
      tipCount: SPLASH_TIPS.length,
      labelWidth: 24,
      descriptions: "full",
    });
  });

  it("stacks the wordmark under the mark when it will not fit beside it", () => {
    // Below 100 inner columns the pair cannot share a line. Stacking
    // needs only the mark's own width, so the mark keeps its name
    // instead of going anonymous — at the price of four rows.
    expect(computeSplashFit({ columns: 92, rows: 40 })).toEqual({
      logo: "full",
      wordmarkPlacement: "below",
      wordmark: true,
      tagline: true,
      tipCount: SPLASH_TIPS.length,
      labelWidth: 24,
      descriptions: "full",
    });
  });

  it("steps the mark down rather than draw it nameless", () => {
    // 88 inner columns is too narrow to park the wordmark beside the
    // 51-column `full` mark, and 30 rows too short to stack it under
    // one. Rather than draw a nameless mark, drop to `small`, which the
    // wordmark fits beside. Mark-over-tips is the documented priority;
    // mark-over-wordmark is not.
    const fit = computeSplashFit({ columns: 92, rows: 30 });
    expect(fit.logo).toBe("small");
    expect(fit.wordmarkPlacement).toBe("beside");
    expect(fit.wordmark).toBe(true);
  });

  it("never loses the wordmark as the surface grows taller", () => {
    // Regression: `full` is 24 rows and cannot stack the wordmark until
    // 32 rows of chat surface, so a naive "biggest mark that fits" drew
    // a NAMELESS full mark at 28 rows while both 24 rows (small, beside)
    // and 32 rows (full, below) named the app. Growing a window must
    // never cost the product its name.
    for (let columns = 60; columns <= 200; columns += 4) {
      let seen = false;
      for (let rows = 2; rows <= 60; rows += 1) {
        const fit = computeSplashFit({ columns, rows });
        if (fit.wordmark) seen = true;
        else if (seen) {
          throw new Error(
            `wordmark lost at ${columns}x${rows} (logo=${fit.logo})`,
          );
        }
      }
    }
  });

  it("shrinks the mark when the surface is too short for the tall artwork", () => {
    // `full` is 24 rows and wants 28 before the tips; 20 rows buys the
    // 14-row `small` instead, which is the documented mark-over-tips
    // priority working in reverse.
    expect(computeSplashFit({ columns: 73, rows: 20 })).toEqual({
      logo: "small",
      wordmarkPlacement: "none",
      wordmark: false,
      tagline: false,
      // One row short of the pane by design — see SPLASH_SLACK_ROWS.
      tipCount: 4,
      labelWidth: 24,
      descriptions: "full",
    });
  });

  it("falls back to the smallest mark and terse copy on a small window", () => {
    expect(computeSplashFit({ columns: 38, rows: 12 })).toEqual({
      logo: "mini",
      wordmarkPlacement: "none",
      wordmark: false,
      tagline: false,
      // 12 rows − 5 for the mark − 1 margin − 1 slack leaves five of the
      // six tips.
      tipCount: 6,
      labelWidth: 10,
      descriptions: "short",
    });
  });

  it("keeps bare labels when there is no room for any description", () => {
    const fit = computeSplashFit({ columns: 20, rows: 10 });
    expect(fit.logo).toBe("mini");
    expect(fit.descriptions).toBe("none");
    expect(fit.labelWidth).toBe(0);
    expect(fit.tipCount).toBeGreaterThan(0);
  });

  it("draws the tiny sign where mini was too big to earn its rows", () => {
    // Five rows used to buy mini at the cost of every tip; the two-row
    // sign keeps a tip on screen beside the brand.
    const short = computeSplashFit({ columns: 38, rows: 5 });
    expect(short.logo).toBe("tiny");
    expect(short.tipCount).toBe(1);
    // Nine columns (five inner): mini is six wide and could not draw at
    // all here — this band really did render no mark before.
    const narrow = computeSplashFit({ columns: 9, rows: 24 });
    expect(narrow.logo).toBe("tiny");
    expect(narrow.wordmark).toBe(false);
  });

  it("drops the mark rather than overflow a two-row surface", () => {
    // Reversed deliberately. The old floor was a one-line text mark, so
    // the tips were what got dropped. The mark is real artwork at every
    // size now, and on a two-row surface the tips are the half worth
    // keeping — Ink paints an over-tall frame over the rows above it, so
    // "draw the mark anyway" is the bug this whole module exists for.
    expect(computeSplashFit({ columns: 92, rows: 2 })).toMatchObject({
      logo: "none",
      tipCount: 2,
    });
  });

  it("survives a degenerate surface without going negative", () => {
    const fit = computeSplashFit({ columns: 0, rows: 0 });
    expect(fit.tipCount).toBe(0);
    expect(fit.labelWidth).toBe(0);
    expect(fit.logo).toBe("none");
  });

  it("plans a layout that fits the surface it was given", () => {
    for (let columns = 10; columns <= 200; columns += 3) {
      for (let rows = 2; rows <= 60; rows += 3) {
        const fit = computeSplashFit({ columns, rows });
        const markHeight = markRows(fit);
        const height =
          markHeight +
          (fit.tipCount > 0 ? (markHeight > 0 ? 1 : 0) + fit.tipCount : 0);
        expect(height).toBeLessThanOrEqual(rows);
        expect(fit.tipCount).toBeGreaterThanOrEqual(0);
        expect(fit.labelWidth).toBeGreaterThanOrEqual(0);
        // `mini` and `tiny` are bullet-sized; they never carry the wordmark.
        if (fit.wordmark) expect(["full", "small"]).toContain(fit.logo);
      }
    }
  });

  it("never shrinks the mark as the terminal gets wider", () => {
    let previous = -1;
    for (let columns = 10; columns <= 200; columns += 1) {
      const choice = computeSplashFit({ columns, rows: 60 }).logo;
      const rank = choice === "none" ? -1 : SIZE_ORDER.indexOf(choice);
      expect(rank).toBeGreaterThanOrEqual(previous);
      previous = rank;
    }
  });

  it("never shows fewer tips as the terminal grows, for a fixed lockup", () => {
    // Across a change of lockup the count legitimately drops: a taller
    // window buys a taller mark — or buys the stacked wordmark, which
    // costs three rows — and both are paid for in tip rows. Within one
    // lockup the list may only grow. Keying on the variant alone is
    // what this used to assert, and it stopped being the right key when
    // gaining the wordmark became something a *taller* window can do.
    const perLockup = new Map<string, number>();
    for (let rows = 2; rows <= 80; rows += 1) {
      const { logo, wordmarkPlacement, tipCount } = computeSplashFit({
        columns: 92,
        rows,
      });
      const key = `${logo}:${wordmarkPlacement}`;
      expect(tipCount).toBeGreaterThanOrEqual(perLockup.get(key) ?? 0);
      perLockup.set(key, tipCount);
    }
    expect(perLockup.get("full:below")).toBe(SPLASH_TIPS.length);
  });
});
