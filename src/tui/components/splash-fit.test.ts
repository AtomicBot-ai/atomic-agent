import { describe, expect, it } from "vitest";
import {
  computeSplashFit,
  LOGO_METRICS,
  SPLASH_TIPS,
  type LogoVariant,
} from "./splash-fit.js";

const SIZE_ORDER: readonly LogoVariant[] = ["mini", "small", "full"];

describe("computeSplashFit", () => {
  it("gives a roomy terminal the full artwork, the wordmark and every tip", () => {
    expect(computeSplashFit({ columns: 92, rows: 40 })).toEqual({
      logo: "full",
      wordmark: true,
      tagline: true,
      tipCount: SPLASH_TIPS.length,
      labelWidth: 24,
      descriptions: "full",
    });
  });

  it("drops the wordmark before the mark when the surface narrows", () => {
    // 82 inner columns — one short of mark + gap + wordmark.
    const fit = computeSplashFit({ columns: 86, rows: 40 });
    expect(fit.logo).toBe("full");
    expect(fit.wordmark).toBe(false);
    expect(fit.tagline).toBe(false);
  });

  it("shrinks the mark when the surface is too short for the tall artwork", () => {
    // A 100x24 terminal leaves the chat surface 73x16.
    expect(computeSplashFit({ columns: 73, rows: 16 })).toEqual({
      logo: "small",
      wordmark: false,
      tagline: false,
      // `small` is 12 rows now, not 10 — it is scaled from the full mark
      // rather than hand-drawn, and the honest half-scale of a 20-row
      // drawing is 12 half-block rows. Two of those rows come out of the
      // tip list, which is the documented mark-over-tips priority.
      tipCount: 3,
      labelWidth: 24,
      descriptions: "full",
    });
  });

  it("falls back to the smallest mark and terse copy on a small window", () => {
    expect(computeSplashFit({ columns: 38, rows: 12 })).toEqual({
      logo: "mini",
      wordmark: false,
      tagline: false,
      // 12 rows − 4 for the mark − 1 margin leaves room for all six
      // tips (the list lost its two hotkey rows).
      tipCount: SPLASH_TIPS.length,
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
        const markHeight =
          fit.logo === "none" ? 0 : LOGO_METRICS[fit.logo].height;
        const height =
          markHeight +
          (fit.tipCount > 0 ? (markHeight > 0 ? 1 : 0) + fit.tipCount : 0);
        expect(height).toBeLessThanOrEqual(rows);
        expect(fit.tipCount).toBeGreaterThanOrEqual(0);
        expect(fit.labelWidth).toBeGreaterThanOrEqual(0);
        if (fit.wordmark) expect(fit.logo).toBe("full");
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

  it("never shows fewer tips as the terminal grows, for a fixed mark", () => {
    // Across a variant change the count legitimately drops: a taller
    // window buys a taller mark, which is paid for in tip rows. Within
    // one variant the list may only grow.
    const perVariant = new Map<string, number>();
    for (let rows = 2; rows <= 80; rows += 1) {
      const { logo, tipCount } = computeSplashFit({ columns: 92, rows });
      expect(tipCount).toBeGreaterThanOrEqual(perVariant.get(logo) ?? 0);
      perVariant.set(logo, tipCount);
    }
    expect(perVariant.get("full")).toBe(SPLASH_TIPS.length);
  });
});
