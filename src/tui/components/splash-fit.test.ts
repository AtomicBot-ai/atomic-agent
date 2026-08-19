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
      tipCount: 5,
      labelWidth: 24,
      descriptions: "full",
    });
  });

  it("falls back to the one-line mark and terse copy on a small window", () => {
    expect(computeSplashFit({ columns: 38, rows: 12 })).toEqual({
      logo: "mini",
      wordmark: false,
      tagline: false,
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

  it("drops the tip list entirely rather than overflow a two-row surface", () => {
    expect(computeSplashFit({ columns: 92, rows: 2 })).toMatchObject({
      logo: "mini",
      tipCount: 0,
      descriptions: "none",
    });
  });

  it("survives a degenerate surface without going negative", () => {
    const fit = computeSplashFit({ columns: 0, rows: 0 });
    expect(fit.tipCount).toBe(0);
    expect(fit.labelWidth).toBe(0);
    expect(fit.logo).toBe("mini");
  });

  it("plans a layout that fits the surface it was given", () => {
    for (let columns = 10; columns <= 200; columns += 3) {
      for (let rows = 2; rows <= 60; rows += 3) {
        const fit = computeSplashFit({ columns, rows });
        const height =
          LOGO_METRICS[fit.logo].height + (fit.tipCount > 0 ? 1 + fit.tipCount : 0);
        expect(height).toBeLessThanOrEqual(Math.max(rows, LOGO_METRICS.mini.height));
        expect(fit.tipCount).toBeGreaterThanOrEqual(0);
        expect(fit.labelWidth).toBeGreaterThanOrEqual(0);
        if (fit.wordmark) expect(fit.logo).toBe("full");
      }
    }
  });

  it("never shrinks the mark as the terminal gets wider", () => {
    let previous = 0;
    for (let columns = 10; columns <= 200; columns += 1) {
      const rank = SIZE_ORDER.indexOf(computeSplashFit({ columns, rows: 60 }).logo);
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
