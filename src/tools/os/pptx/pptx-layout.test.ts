import { describe, expect, it } from "vitest";
import type { ChartSpec } from "../ooxml/ooxml-chart.js";
import { OS_FS_WRITE_PPTX_CONTRACT } from "./pptx-contract.js";
import {
  MOVED_NOTES_HEADING,
  PPTX_LAYOUTS,
  fitSlideText,
  isNumberLike,
  isComparisonLike,
  isQuoteLike,
  isTimelineLike,
  layoutSlide,
  pickLayout,
  resolveLayout,
  splitColumns,
} from "./pptx-layout.js";
import { parseBullet, type PptxSlideSpec } from "./pptx-spec.js";

function slide(over: Partial<Omit<PptxSlideSpec, "bullets">> & { bullets?: string[] } = {}): PptxSlideSpec {
  const { bullets = [], ...rest } = over;
  return { title: "Topic", ...rest, bullets: bullets.map(parseBullet) };
}

const CHART: ChartSpec = { type: "column", categories: ["Q1"], series: [{ name: "EU", values: [1] }] };
const many = (n: number) => Array.from({ length: n }, (_, i) => `Point ${i + 1}`);

describe("isNumberLike / isQuoteLike", () => {
  it("reads a short figure as a number and leaves sentences alone", () => {
    for (const t of ["42%", "$1.2M", "3x", "10,000", "+18 pts", "~2.5bn", "€40k"]) expect(isNumberLike(t), t).toBe(true);
    for (const t of ["Q3 review", "2026 roadmap", "Top 5 risks", "1234567890123", ""]) expect(isNumberLike(t), t).toBe(false);
  });

  it("reads a title wrapped in quote marks as a quote", () => {
    expect(isQuoteLike("“Ship small, ship often.”")).toBe(true);
    expect(isQuoteLike('"The best tool is the one you use."')).toBe(true);
    expect(isQuoteLike("Ship small")).toBe(false);
    expect(isQuoteLike('"Hi"')).toBe(false);
  });
});

describe("pickLayout", () => {
  it("picks big-number for a figure headline with at most one bullet", () => {
    expect(pickLayout(slide({ title: "42%" }))).toBe("big-number");
    expect(pickLayout(slide({ title: "42%", bullets: ["of users came back"] }))).toBe("big-number");
    expect(pickLayout(slide({ title: "42%", bullets: ["a", "b"] }))).toBe("bullets");
  });

  it("picks quote for a quoted title alone and title for a plain one", () => {
    expect(pickLayout(slide({ title: "“Ship small, ship often.”", subtitle: "Team motto" }))).toBe("quote");
    expect(pickLayout(slide({ title: "Q3 review", subtitle: "Sales" }))).toBe("title");
  });

  it("picks image-full for a picture without bullets, bullets beside one otherwise", () => {
    expect(pickLayout(slide({ image: "a.png" }))).toBe("image-full");
    expect(pickLayout(slide({ image: "a.png", bullets: ["Look"] }))).toBe("bullets");
  });

  it("picks chart for chart data with up to three bullets", () => {
    expect(pickLayout(slide({ chart: CHART }))).toBe("chart");
    expect(pickLayout(slide({ chart: CHART, bullets: many(3) }))).toBe("chart");
    expect(pickLayout(slide({ chart: CHART, bullets: many(4) }))).toBe("bullets");
    // A number-like title does not beat the chart.
    expect(pickLayout(slide({ title: "42%", chart: CHART }))).toBe("chart");
  });

  it("splits seven or more bullets into two columns, keeps six in one", () => {
    expect(pickLayout(slide({ bullets: many(6) }))).toBe("bullets");
    expect(pickLayout(slide({ bullets: many(7) }))).toBe("two-column");
    // One parent with many sub-points cannot be split: one column.
    expect(pickLayout(slide({ bullets: ["Parent", ...many(7).map((b) => `  ${b}`)] }))).toBe("bullets");
  });

  it("lets a table with at most two bullets lead the slide, more keep the half/half bullets layout", () => {
    expect(pickLayout(slide({ table: [["A"], ["1"]] }))).toBe("table");
    expect(pickLayout(slide({ table: [["A"], ["1"]], bullets: many(2) }))).toBe("table");
    expect(pickLayout(slide({ table: [["A"], ["1"]], bullets: many(3) }))).toBe("bullets");
  });

  it("makes a title-only slide after the first a section header (ATO-2444)", () => {
    expect(pickLayout(slide({ title: "Part 2: Results" }), 0)).toBe("title");
    expect(pickLayout(slide({ title: "Part 2: Results", subtitle: "What we learned" }), 3)).toBe("section");
    expect(pickLayout(slide({ title: "“Ship small, ship often.”" }), 3)).toBe("quote");
  });

  it("reads two headed sides as a comparison and dated steps as a timeline (ATO-2444)", () => {
    const sides = ["Before", "  Manual", "  Slow", "After", "  Automatic"];
    expect(isComparisonLike(sides.map(parseBullet))).toBe(true);
    expect(pickLayout(slide({ bullets: sides }))).toBe("comparison");
    expect(isComparisonLike(["Before", "After", "  Fast"].map(parseBullet))).toBe(false);
    const steps = ["2024: Prototype", "Q1 2025 - Beta", "Jun 2025: Launch", "Step 4: Grow"];
    expect(isTimelineLike(steps.map(parseBullet))).toBe(true);
    expect(pickLayout(slide({ bullets: steps }))).toBe("timeline");
    expect(isTimelineLike(["Marketing: grow", "Sales: sell", "Support: help"].map(parseBullet))).toBe(false);
    expect(isTimelineLike(["2024: a", "2025: b"].map(parseBullet))).toBe(false);
  });
});

describe("resolveLayout", () => {
  it("keeps a named layout that fits and falls back to the automatic one otherwise", () => {
    expect(resolveLayout(slide({ bullets: many(3), layout: "two-column" }))).toBe("two-column");
    expect(resolveLayout(slide({ title: "Revenue", layout: "big-number" }))).toBe("big-number");
    // A picture cannot go on a quote slide; a chart layout needs a chart.
    expect(resolveLayout(slide({ image: "a.png", layout: "quote" }))).toBe("image-full");
    expect(resolveLayout(slide({ bullets: many(2), layout: "chart" }))).toBe("bullets");
    expect(resolveLayout(slide({ chart: CHART, bullets: many(5), layout: "bullets" }))).toBe("bullets");
  });
});

describe("fitSlideText", () => {
  it("leaves a slide that fits untouched", () => {
    const s = slide({ bullets: many(6), notes: "Say hi" });
    expect(fitSlideText(s, "bullets")).toEqual({ slide: s, moved: 0 });
  });

  it("moves bullets past the count cap to the end of the notes, levels kept", () => {
    const s = slide({ bullets: [...many(5), "Sixth", "  Sub of sixth", "Eighth"], notes: "Say hi" });
    const { slide: fitted, moved } = fitSlideText(s, "bullets");
    expect(moved).toBe(2);
    expect(fitted.bullets.map((b) => b.text)).toEqual([...many(5), "Sixth"]);
    expect(fitted.notes).toBe(`Say hi\n\n${MOVED_NOTES_HEADING}\n  - Sub of sixth\n- Eighth`);
  });

  it("moves bullets whose text no longer fits the box, but always keeps the first (ATO-2444: measured)", () => {
    const long = "word ".repeat(200).trim();
    const { slide: fitted, moved } = fitSlideText(slide({ bullets: [long, "short but over"] }), "bullets");
    expect(fitted.bullets).toHaveLength(1);
    expect(moved).toBe(1);
    expect(fitted.notes).toBe(`${MOVED_NOTES_HEADING}\n- short but over`);

    const huge = "y".repeat(2_000);
    expect(fitSlideText(slide({ bullets: [huge] }), "bullets").moved).toBe(0);
  });

  it("measures width: wide letters fill the box sooner than narrow ones, and a column sooner than the full width", () => {
    const wide = Array.from({ length: 6 }, () => "WWWW MMMM WWWW MMMM WWWW MMMM WWWW MMMM WWWW MMMM WWWW MMMM");
    const narrow = Array.from({ length: 6 }, () => "iiii llll iiii llll iiii llll iiii llll iiii llll iiii llll");
    expect(fitSlideText(slide({ bullets: wide }), "bullets").moved).toBeGreaterThan(0);
    expect(fitSlideText(slide({ bullets: narrow }), "bullets").moved).toBe(0);
    const medium = Array.from({ length: 4 }, () => "A sentence of ordinary words that runs for about one long line here");
    expect(fitSlideText(slide({ bullets: medium }), "bullets").moved).toBe(0);
    expect(fitSlideText(slide({ bullets: medium, chart: CHART }), "chart").moved).toBeGreaterThan(0);
  });

  it("uses the narrower cap beside a picture, table or chart", () => {
    expect(fitSlideText(slide({ image: "a.png", bullets: many(6) }), "bullets").moved).toBe(1);
    expect(fitSlideText(slide({ chart: CHART, bullets: many(5) }), "chart").moved).toBe(2);
  });

  it("moves every bullet off layouts that show none", () => {
    for (const layout of ["title", "quote", "image-full"] as const) {
      const { slide: fitted, moved } = fitSlideText(slide({ bullets: many(2) }), layout);
      expect(fitted.bullets, layout).toEqual([]);
      expect(moved, layout).toBe(2);
    }
    expect(fitSlideText(slide({ title: "42%", bullets: many(3) }), "big-number").moved).toBe(2);
  });
});

describe("layoutSlide", () => {
  it("stamps the layout it used and fits the text to it", () => {
    const laid = layoutSlide(slide({ bullets: many(14) }));
    expect(laid.layout).toBe("two-column");
    expect(laid.slide.layout).toBe("two-column");
    expect(laid.slide.bullets).toHaveLength(12);
    expect(laid.moved).toBe(2);
  });
});

describe("layoutSlide comparison fit", () => {
  const texts = (l: { slide: PptxSlideSpec }) => l.slide.bullets.map((b) => b.text);

  it("fits each side in its own column, at the lifted size, not one tall area (review of #2071)", () => {
    const point = "  Manual export of every report by hand weekly";
    const laid = layoutSlide(slide({ bullets: ["Before", ...Array<string>(9).fill(point), "After", "  One click"] }));
    // Nine two-line points at 24 pt do not fit one column BODY_BOX.cy tall.
    expect(laid.layout).toBe("comparison");
    expect(laid.moved).toBeGreaterThan(0);
    expect(texts(laid).slice(-2)).toEqual(["After", "One click"]);
    expect(laid.slide.notes).toContain(`${MOVED_NOTES_HEADING}\n  - Manual export`);
  });

  it("holds a heading and six points per side, the right side kept whatever the left holds", () => {
    const left = Array.from({ length: 13 }, (_, i) => `  Point ${i + 1}`);
    const laid = layoutSlide(slide({ bullets: ["Left", ...left, "Right", "  Only"] }));
    expect(laid.layout).toBe("comparison");
    expect(laid.moved).toBe(7);
    expect(texts(laid)).toEqual(["Left", ...left.slice(0, 6).map((t) => t.trim()), "Right", "Only"]);
  });

  it("draws plain bullets when a side keeps no points", () => {
    const huge = `  ${"word ".repeat(300).trim()}`;
    for (const bullets of [["Left", "  a", "Right", huge], ["Left", huge, "Right", "  b"]]) {
      const laid = layoutSlide(slide({ bullets }));
      expect(laid.layout, bullets[1]).toBe("bullets");
      expect(laid.slide.layout).toBe("bullets");
    }
  });
});

describe("splitColumns", () => {
  it("splits at the middle, on a top-level bullet so sub-points stay with their parent", () => {
    const [left, right] = splitColumns(["A", "  a1", "  a2", "B", "C", "  c1", "D"].map(parseBullet));
    expect(left.map((b) => b.text)).toEqual(["A", "a1", "a2", "B"]);
    expect(right.map((b) => b.text)).toEqual(["C", "c1", "D"]);
    const [l2, r2] = splitColumns(many(7).map(parseBullet));
    expect([l2.length, r2.length]).toEqual([4, 3]);
  });
});

describe("contract", () => {
  it("offers exactly the layouts the renderer draws", () => {
    const items = OS_FS_WRITE_PPTX_CONTRACT.argsJsonSchema.properties.slides.items;
    expect(items.properties.layout.enum).toEqual([...PPTX_LAYOUTS]);
    expect(OS_FS_WRITE_PPTX_CONTRACT.descriptor.argsSchema).toContain(
      PPTX_LAYOUTS.map((l) => `"${l}"`).join(" | "),
    );
  });

  it("tells the model to take numbers and quotes only from the user's sources", () => {
    expect(OS_FS_WRITE_PPTX_CONTRACT.description).toMatch(/numbers, statistics and quotes .* only when they come from the user/i);
    expect(OS_FS_WRITE_PPTX_CONTRACT.descriptor.summary).toMatch(/never invented/);
  });
});
