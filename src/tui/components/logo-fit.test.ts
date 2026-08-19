import { describe, expect, it } from "vitest";
import { LOGO_ART, TAGLINE, WORDMARK_ROWS } from "./logo.js";
import { LOGO_METRICS, WORDMARK_WIDTH, type LogoVariant } from "./splash-fit.js";

function measure(rows: readonly string[]): { width: number; height: number } {
  return {
    width: rows.reduce((acc, row) => Math.max(acc, row.length), 0),
    height: rows.length,
  };
}

/**
 * `splash-fit.ts` picks a mark from numbers it keeps in `LOGO_METRICS`;
 * the artwork itself lives in `logo.tsx`. If the two ever drift the
 * breakpoints silently start lying, so measure the real rows here.
 */
describe("logo artwork", () => {
  const variants: readonly LogoVariant[] = ["full", "small", "mini"];

  it.each(variants)("matches the declared metrics for %s", (variant) => {
    expect(measure(LOGO_ART[variant])).toEqual(LOGO_METRICS[variant]);
  });

  it("orders the variants strictly smallest-last", () => {
    expect(LOGO_METRICS.full.width).toBeGreaterThan(LOGO_METRICS.small.width);
    expect(LOGO_METRICS.small.width).toBeGreaterThan(LOGO_METRICS.mini.width);
    expect(LOGO_METRICS.full.height).toBeGreaterThan(LOGO_METRICS.small.height);
    expect(LOGO_METRICS.small.height).toBeGreaterThan(LOGO_METRICS.mini.height);
  });

  it("matches the declared wordmark width and keeps the tagline narrower", () => {
    expect(measure(WORDMARK_ROWS).width).toBe(WORDMARK_WIDTH);
    expect(TAGLINE.length).toBeLessThanOrEqual(WORDMARK_WIDTH);
  });
});
