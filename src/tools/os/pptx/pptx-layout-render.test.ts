import { XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { pptxExtractor } from "../read-document/extractors/pptx-extractor.js";
import { buildPptx, type PptxImageInput } from "./pptx-build.js";
import { sniffImage } from "./pptx-image.js";
import { MOVED_NOTES_HEADING } from "./pptx-layout.js";
import { parseDeckSpec } from "./pptx-spec.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const NOW = new Date("2026-11-27T10:00:00.000Z");
const CHART = { type: "column", categories: ["Q1", "Q2"], series: [{ name: "EU", values: [1, 2] }] };
const points = (n: number) => Array.from({ length: n }, (_, i) => `Point ${i + 1}`);

async function build(slides: Record<string, unknown>[], images?: Map<number, PptxImageInput>) {
  const built = await buildPptx({ spec: parseDeckSpec({ path: "deck.pptx", slides }), now: NOW, ...(images ? { images } : {}) });
  const zip = await JSZip.loadAsync(built.data);
  const part = async (path: string) => {
    const file = zip.file(path);
    if (!file) throw new Error(`missing part ${path}`);
    return file.async("text");
  };
  return { built, zip, part };
}

describe("buildPptx layouts", () => {
  it("picks a layout per slide from its content and reports it", async () => {
    const { built } = await build([
      { title: "Q3 review", subtitle: "Sales" },
      { title: "42%", subtitle: "of trials converted" },
      { title: "“Ship small, ship often.”", subtitle: "Team motto" },
      { title: "Agenda", bullets: points(8) },
      { title: "Trend", chart: CHART },
      { title: "Goals", bullets: points(3) },
    ]);
    expect(built.layouts.map((s) => s.layout)).toEqual(["title", "big-number", "quote", "two-column", "chart", "bullets"]);
    expect(built.layouts.every((s) => s.moved === 0)).toBe(true);
  });

  it("draws every layout as well-formed XML the PPTX reader reads back", async () => {
    const image: PptxImageInput = { data: PNG_1X1, info: sniffImage(PNG_1X1)!, name: "photo.png" };
    const { built, zip } = await build(
      [
        { title: "42%", bullets: ["of trials converted"] },
        { title: "“Ship small, ship often.”", subtitle: "Team motto" },
        { title: "Agenda", bullets: points(8) },
        { title: "Office", subtitle: "Our new home", image: "photo.png" },
        { title: "Trend", bullets: ["Up"], chart: CHART },
      ],
      new Map([[3, image]]),
    );
    for (let n = 1; n <= 5; n += 1) {
      expect(XMLValidator.validate(await zip.file(`ppt/slides/slide${n}.xml`)!.async("text")), `slide${n}`).toBe(true);
    }
    expect(built.imageCount).toBe(1);
    expect(built.chartCount).toBe(1);
    const text = (await pptxExtractor({ data: built.data, sourcePath: "deck.pptx" })).text;
    for (const expected of ["42%", "of trials converted", "Ship small, ship often.", "Team motto", "Point 1", "Point 8", "Our new home", "Up"]) {
      expect(text).toContain(expected);
    }
  });

  it("sets a big number in the accent colour and splits two columns into two text areas", async () => {
    const { part } = await build([
      { title: "42%", bullets: ["of trials converted"] },
      { title: "Agenda", bullets: points(8) },
    ]);
    const number = await part("ppt/slides/slide1.xml");
    expect(number).toMatch(/sz="11500" b="1"><a:solidFill><a:srgbClr val="[0-9A-F]{6}"\/><\/a:solidFill><\/a:rPr><a:t>42%<\/a:t>/);
    expect(number).not.toContain('name="Accent 3"');
    const columns = await part("ppt/slides/slide2.xml");
    expect(columns).toContain('<p:ph type="body" idx="1"/>');
    expect(columns).toContain('name="Content 7"');
    const [left, right] = columns.split('name="Content 7"');
    expect(left).toContain("<a:t>Point 4</a:t>");
    expect(left).not.toContain("<a:t>Point 5</a:t>");
    expect(right).toContain("<a:t>Point 5</a:t>");
    expect(right).toContain("<a:t>Point 8</a:t>");
  });

  it("gives a chart two thirds of the body when it has bullets, all of it without", async () => {
    const { part } = await build([
      { title: "Trend", chart: CHART },
      { title: "Trend", bullets: ["Up"], chart: CHART },
    ]);
    const width = (xml: string) => Number(/name="Chart 6"[\s\S]*?<a:ext cx="(\d+)"/.exec(xml)?.[1]);
    const full = width(await part("ppt/slides/slide1.xml"));
    const beside = width(await part("ppt/slides/slide2.xml"));
    expect(full).toBeGreaterThan(0);
    expect(beside).toBeGreaterThan(full / 2);
    expect(beside).toBeLessThan(full);
  });

  it("moves bullets a layout cannot hold to the speaker notes instead of the slide", async () => {
    const { built, part } = await build([
      { title: "Goals", bullets: points(9), layout: "bullets", notes: "Open with the why." },
      { title: "42%", bullets: ["of trials converted", "up from 30%"], layout: "big-number" },
    ]);
    expect(built.layouts).toEqual([
      { layout: "bullets", moved: 3 },
      { layout: "big-number", moved: 1 },
    ]);
    expect(built.notesCount).toBe(2);
    const slide = await part("ppt/slides/slide1.xml");
    expect(slide).toContain("<a:t>Point 6</a:t>");
    expect(slide).not.toContain("<a:t>Point 7</a:t>");
    const notes = await part("ppt/notesSlides/notesSlide1.xml");
    expect(notes).toContain("Open with the why.");
    expect(notes).toContain(MOVED_NOTES_HEADING);
    expect(notes).toContain("- Point 7");
    expect(notes).toContain("- Point 9");
    // A slide without notes of its own gets a notes page for what moved.
    expect(await part("ppt/notesSlides/notesSlide2.xml")).toContain("- up from 30%");
  });

  it("refuses an unknown layout name and accepts one in any case", () => {
    expect(() => parseDeckSpec({ path: "d.pptx", slides: [{ title: "T", layout: "grid" }] })).toThrow(
      /slides\[0\]\.layout must be one of title, bullets, two-column, quote, big-number, image-full, chart/,
    );
    expect(parseDeckSpec({ path: "d.pptx", slides: [{ title: "T", layout: " Quote " }] }).slides[0]!.layout).toBe("quote");
    expect(parseDeckSpec({ path: "d.pptx", slides: [{ title: "T", layout: null }] }).slides[0]).toEqual({ title: "T", bullets: [] });
  });
});
