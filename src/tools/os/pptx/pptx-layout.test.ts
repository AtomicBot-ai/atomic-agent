import { describe, expect, it } from "vitest";
import type { ChartSpec } from "../ooxml/ooxml-chart.js";
import { OS_FS_WRITE_PPTX_CONTRACT } from "./pptx-contract.js";
import {
  LAYOUT_TEXT_CAPS,
  MOVED_NOTES_HEADING,
  PPTX_LAYOUTS,
  fitSlideText,
  isNumberLike,
  isQuoteLike,
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

  it("keeps a table in the bullets layout", () => {
    expect(pickLayout(slide({ table: [["A"], ["1"]] }))).toBe("bullets");
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

  it("moves bullets past the character budget, but always keeps the first", () => {
    const long = "x".repeat(LAYOUT_TEXT_CAPS.bullets.chars - 10);
    const { slide: fitted, moved } = fitSlideText(slide({ bullets: [long, "short but over"] }), "bullets");
    expect(fitted.bullets).toHaveLength(1);
    expect(moved).toBe(1);
    expect(fitted.notes).toBe(`${MOVED_NOTES_HEADING}\n- short but over`);

    const huge = "y".repeat(LAYOUT_TEXT_CAPS.bullets.chars * 2);
    expect(fitSlideText(slide({ bullets: [huge] }), "bullets").moved).toBe(0);
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
