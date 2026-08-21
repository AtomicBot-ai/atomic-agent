import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CROSS_MARKS, type MarkScale } from "./logo-art.js";

/**
 * `logo-art.ts` is generated from `assets/logo.svg`. Hand-editing it is
 * how the old three hand-drawn copies drifted apart in the first place,
 * so re-run the generator and fail if the checked-in file has moved.
 */
describe("logo-art.ts", () => {
  it("is in sync with assets/logo.svg", () => {
    expect(() =>
      execFileSync("node", ["scripts/generate-logo-art.mjs", "--check"], {
        cwd: new URL("../../../", import.meta.url).pathname,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  const scales: readonly MarkScale[] = ["lg", "md", "sm"];

  it.each(scales)("draws %s the same size in both strokes", (scale) => {
    const block = CROSS_MARKS.block[scale];
    const ascii = CROSS_MARKS.ascii[scale];
    const measure = (rows: readonly string[]) => ({
      width: rows.reduce((acc, row) => Math.max(acc, row.length), 0),
      height: rows.length,
    });
    expect(measure(ascii)).toEqual(measure(block));
  });

  it("orders the scales strictly smallest-last", () => {
    const widths = scales.map((scale) =>
      CROSS_MARKS.ascii[scale].reduce((acc, r) => Math.max(acc, r.length), 0),
    );
    expect(widths[0]).toBeGreaterThan(widths[1]!);
    expect(widths[1]).toBeGreaterThan(widths[2]!);
  });

  it("draws SM at the 9x5 the guidelines specify", () => {
    // The rail uses this verbatim, and `SIDEBAR_CHROME_ROWS` counts its
    // five rows.
    expect(CROSS_MARKS.block.sm).toHaveLength(5);
    expect(
      CROSS_MARKS.block.sm.reduce((acc, row) => Math.max(acc, row.length), 0),
    ).toBe(9);
  });

  it("uses only ASCII in the ascii stroke", () => {
    for (const scale of scales) {
      for (const row of CROSS_MARKS.ascii[scale]) {
        expect(row).toMatch(/^[ #+.]*$/u);
      }
    }
  });
});
