import { XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { pptxExtractor } from "../read-document/extractors/pptx-extractor.js";
import { buildPptx } from "./pptx-build.js";
import { comparisonSides, timelineStep } from "./pptx-layout-render-extra.js";
import { parseBullet, parseDeckSpec } from "./pptx-spec.js";

/** ATO-2444: section header, comparison, timeline and table-led slides. */
const NOW = new Date("2026-11-27T10:00:00.000Z");

async function build(slides: Record<string, unknown>[]) {
  const built = await buildPptx({ spec: parseDeckSpec({ path: "deck.pptx", slides }), now: NOW });
  const zip = await JSZip.loadAsync(built.data);
  const slide = (n: number) => zip.file(`ppt/slides/slide${n}.xml`)!.async("text");
  return { built, slide };
}

describe("the ATO-2444 layouts", () => {
  it("are picked from content, drawn as well-formed XML, and read back", async () => {
    const { built, slide } = await build([
      { title: "Quarterly review" },
      { title: "Part 2: Results", subtitle: "What we learned" },
      { title: "Then and now", bullets: ["Before", "  Manual export", "  Two days", "After", "  One click"] },
      { title: "Roadmap", bullets: ["2024: Prototype", "Q1 2025 - Beta", "Jun 2025: Launch"] },
      { title: "Pricing", subtitle: "Per seat", table: [["Plan", "Price"], ["Pro", 20]] },
    ]);
    expect(built.layouts.map((l) => l.layout)).toEqual(["title", "section", "comparison", "timeline", "table"]);
    for (let n = 1; n <= 5; n += 1) expect(XMLValidator.validate(await slide(n)), `slide${n}`).toBe(true);
    // Shape ids stay unique on every slide.
    for (let n = 2; n <= 5; n += 1) {
      const ids = [...(await slide(n)).matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
      expect(new Set(ids).size, `slide${n}`).toBe(ids.length);
    }
    const timeline = await slide(4);
    expect(timeline.match(/prst="ellipse"/g)).toHaveLength(3);
    expect(timeline).toContain("<a:t>2024</a:t>");
    expect(timeline).toContain("<a:t>Prototype</a:t>");
    expect(await slide(5)).toContain('<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">');
    const text = (await pptxExtractor({ data: built.data, sourcePath: "deck.pptx" })).text;
    for (const word of ["Part 2: Results", "What we learned", "Before", "Manual export", "After", "One click", "Launch", "Pro"]) {
      expect(text, word).toContain(word);
    }
  });

  it("keeps a named layout that fits and replaces one that does not", async () => {
    const { built } = await build([
      { title: "Intro", layout: "section" },
      { title: "Steps", bullets: ["Plan", "Build", "Ship"], layout: "timeline" },
      { title: "Steps", bullets: ["Plan", "  detail"], layout: "timeline" },
      { title: "No table", bullets: ["a"], layout: "table" },
    ]);
    expect(built.layouts.map((l) => l.layout)).toEqual(["section", "timeline", "bullets", "bullets"]);
  });

  it("moves timeline steps past six to the notes", async () => {
    const steps = Array.from({ length: 6 }, (_, i) => `Step ${i + 1}: do ${i + 1}`);
    const { built } = await build([{ title: "Plan", bullets: steps, layout: "timeline" }, { title: "More", bullets: [...steps, "Step 7: rest"], layout: "timeline" }]);
    expect(built.layouts[0]).toEqual({ layout: "timeline", moved: 0 });
    expect(built.layouts[1]).toEqual({ layout: "timeline", moved: 1 });
  });
});

describe("helpers", () => {
  it("splits a comparison at its second heading and a step at its marker", () => {
    const [left, right] = comparisonSides(["A", "  a1", "B", "  b1", "  b2"].map(parseBullet));
    expect(left.map((b) => b.text)).toEqual(["A", "a1"]);
    expect(right.map((b) => b.text)).toEqual(["B", "b1", "b2"]);
    expect(timelineStep("Q1 2025 - Beta")).toEqual(["Q1 2025", "Beta"]);
    expect(timelineStep("Ship it")).toEqual(["", "Ship it"]);
  });
});
