import { XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { pptxExtractor } from "../read-document/extractors/pptx-extractor.js";
import { buildPptx, type PptxImageInput } from "./pptx-build.js";
import { sniffImage } from "./pptx-image.js";
import { parseDeckSpec } from "./pptx-spec.js";

/** A real 1×1 PNG. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const NOW = new Date("2026-11-12T10:00:00.000Z");

function deck(raw: Record<string, unknown>) {
  return parseDeckSpec({ path: "deck.pptx", ...raw });
}

async function open(data: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(data);
}

async function text(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) throw new Error(`missing part ${path}`);
  return file.async("text");
}

const SAMPLE = {
  title: "Quarterly review",
  slides: [
    { title: "Q3 review", subtitle: "Sales team, November" },
    {
      title: "Highlights",
      bullets: ["Revenue up 12%", "  Driven by EU", "Churn flat"],
      notes: "Mention the EU launch.\nThen pause for questions.",
    },
    { title: "Pricing & <next> steps", bullets: ["Raise \"Pro\" tier", "Keep free plan"] },
  ],
};

describe("buildPptx", () => {
  it("round-trips titles and bullets through the read_document PPTX extractor, in slide order", async () => {
    const built = await buildPptx({ spec: deck(SAMPLE), now: NOW });
    expect(built.slideCount).toBe(3);
    expect(built.notesCount).toBe(1);
    expect(built.imageCount).toBe(0);

    const result = await pptxExtractor({ data: built.data, sourcePath: "deck.pptx" });
    expect(result.slideCount).toBe(3);
    expect(result.pagesExtracted).toEqual([1, 2, 3]);
    const slides = result.text.split(/--- slide \d+ ---/).map((s) => s.trim()).filter(Boolean);
    expect(slides[0]).toContain("Q3 review");
    expect(slides[0]).toContain("Sales team, November");
    expect(slides[1]).toContain("Highlights");
    expect(slides[1]).toContain("Revenue up 12%");
    expect(slides[1]).toContain("Driven by EU");
    // Special characters survive escaping and come back as typed.
    expect(slides[2]).toContain("Pricing & <next> steps");
    expect(slides[2]).toContain('Raise "Pro" tier');
  });

  it("writes speaker notes into a notes slide linked from its slide", async () => {
    const zip = await open((await buildPptx({ spec: deck(SAMPLE), now: NOW })).data);
    const notes = await text(zip, "ppt/notesSlides/notesSlide2.xml");
    expect(notes).toContain("Mention the EU launch.");
    expect(notes).toContain("Then pause for questions.");
    expect(await text(zip, "ppt/slides/_rels/slide2.xml.rels")).toContain("../notesSlides/notesSlide2.xml");
    expect(zip.file("ppt/notesSlides/notesSlide1.xml")).toBeNull();
    expect(await text(zip, "[Content_Types].xml")).toContain("/ppt/notesSlides/notesSlide2.xml");
  });

  it("keeps bullet levels as paragraph levels", async () => {
    const zip = await open((await buildPptx({ spec: deck(SAMPLE), now: NOW })).data);
    const slide = await text(zip, "ppt/slides/slide2.xml");
    expect(slide).toMatch(/<a:pPr lvl="1"\/><a:r><a:rPr[^>]*\/><a:t>Driven by EU<\/a:t>/);
    expect(slide).toContain('<p:ph type="title"/>');
    expect(slide).toContain('<p:ph type="body" idx="1"/>');
  });

  it("produces only well-formed XML, with every relationship target present and every part typed", async () => {
    const image: PptxImageInput = { data: PNG_1X1, info: sniffImage(PNG_1X1)!, name: "chart.png" };
    const spec = deck({
      ...SAMPLE,
      slides: [
        ...SAMPLE.slides,
        { title: "Chart", bullets: ["See right"], image: "chart.png", notes: "n" },
        { title: "Numbers", table: [["Region", "Q3"], ["EU", 12]] },
        { title: "Trend", bullets: ["Up"], chart: { type: "line", categories: ["Q1", "Q2"], series: [{ name: "EU", values: [1, 2] }] } },
      ],
    });
    const zip = await open((await buildPptx({ spec, images: new Map([[3, image]]), now: NOW })).data);
    const names = Object.keys(zip.files).filter((name) => !zip.files[name]!.dir);
    expect(names[0]).toBe("[Content_Types].xml");
    const contentTypes = await text(zip, "[Content_Types].xml");
    for (const name of names) {
      if (name.endsWith(".xml") || name.endsWith(".rels")) {
        const xml = await text(zip, name);
        expect(XMLValidator.validate(xml), name).toBe(true);
      }
      if (name.endsWith(".xml") && name !== "[Content_Types].xml") {
        expect(contentTypes, name).toContain(`PartName="/${name}"`);
      }
      if (name.endsWith(".rels")) {
        const base = name.replace(/_rels\/[^/]*\.rels$/, "");
        const rels = await text(zip, name);
        for (const match of rels.matchAll(/Target="([^"]+)"/g)) {
          const target = match[1]!;
          const resolved = new URL(target, `http://x/${base}`).pathname.slice(1);
          expect(zip.file(resolved), `${name} -> ${target}`).not.toBeNull();
        }
      }
    }
    expect(zip.file("ppt/media/image1.png")).not.toBeNull();
    const slide = await text(zip, "ppt/slides/slide4.xml");
    expect(slide).toContain('r:embed="rId3"');
    expect(slide).toContain('descr="chart.png"');
    expect(zip.file("ppt/charts/chart1.xml")).not.toBeNull();
    expect(zip.file("ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx")).not.toBeNull();
    expect(contentTypes).toContain('<Default Extension="xlsx"');
  });

  it("writes a table as a native a:tbl with the header row first", async () => {
    const spec = deck({
      slides: [
        {
          title: "Pricing",
          bullets: ["Two tiers"],
          table: [["Plan", "Price", "Seats"], ["Free", 0], ["Pro & Team", 20, "<10"]],
        },
      ],
    });
    const built = await buildPptx({ spec, now: NOW });
    expect(built.tableCount).toBe(1);
    const zip = await open(built.data);
    const slide = await text(zip, "ppt/slides/slide1.xml");
    expect(XMLValidator.validate(slide)).toBe(true);
    expect(slide).toContain('<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">');
    expect(slide).toContain('<a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId>');
    expect(slide.match(/<a:gridCol /g)).toHaveLength(3);
    expect(slide.match(/<a:tr /g)).toHaveLength(3);
    // The short row is padded, so every row has three cells.
    expect(slide.match(/<a:tc>/g)).toHaveLength(9);
    expect(slide).toContain("<a:t>Pro &amp; Team</a:t>");
    expect(slide).toContain("<a:t>&lt;10</a:t>");
    // Bullets keep the left half; the table takes the right one.
    expect(slide).toContain('<p:ph type="body" idx="1"/>');
    const result = await pptxExtractor({ data: built.data, sourcePath: "deck.pptx" });
    expect(result.text).toContain("Plan");
    expect(result.text).toContain("Pro & Team");
  });

  it("writes a chart part with its data cached and an embedded workbook for Edit Data", async () => {
    const spec = deck({
      slides: [
        { title: "Intro" },
        {
          title: "Revenue",
          chart: {
            type: "column",
            title: "Revenue by quarter",
            categories: ["Q1", "Q2", "Q3"],
            series: [
              { name: "EU", values: [10, 12, 15] },
              { name: "US", values: [8, 9, 11] },
            ],
          },
          notes: "Point at Q3.",
        },
      ],
    });
    const built = await buildPptx({ spec, now: NOW });
    expect(built.chartCount).toBe(1);
    const zip = await open(built.data);
    const slide = await text(zip, "ppt/slides/slide2.xml");
    expect(slide).toContain('<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">');
    expect(slide).toMatch(/<c:chart xmlns:c="[^"]+" r:id="rId4"\/>/);
    const slideRels = await text(zip, "ppt/slides/_rels/slide2.xml.rels");
    expect(slideRels).toContain(
      'Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"',
    );
    const chart = await text(zip, "ppt/charts/chart1.xml");
    expect(XMLValidator.validate(chart)).toBe(true);
    expect(chart).toContain('<c:barDir val="col"/>');
    expect(chart).toContain("<c:f>Sheet1!$C$2:$C$4</c:f>");
    expect(chart).toContain("<a:t>Revenue by quarter</a:t>");
    expect(await text(zip, "ppt/charts/_rels/chart1.xml.rels")).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Microsoft_Excel_Worksheet1.xlsx"',
    );
    expect(await text(zip, "[Content_Types].xml")).toContain(
      '<Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>',
    );
    const workbook = await JSZip.loadAsync(await zip.file("ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx")!.async("nodebuffer"));
    expect(await workbook.file("xl/worksheets/sheet1.xml")!.async("text")).toContain('<c r="C4"><v>11</v></c>');
    // A chart-only slide is not a title slide: the title keeps its place at the top.
    expect(slide).toContain('name="Accent 3"');
  });

  it("applies the theme and an accent override to the master and theme parts", async () => {
    const zip = await open(
      (await buildPptx({ spec: deck({ ...SAMPLE, theme: "dark", accentColor: "#ff8800", font: "Inter" }), now: NOW })).data,
    );
    const master = await text(zip, "ppt/slideMasters/slideMaster1.xml");
    expect(master).toContain('<a:srgbClr val="111827"/>');
    expect(master).toContain('<a:buClr><a:srgbClr val="FF8800"/></a:buClr>');
    expect(master).toContain('typeface="Inter"');
    expect(await text(zip, "ppt/theme/theme1.xml")).toContain('<a:accent1><a:srgbClr val="FF8800"/></a:accent1>');
  });

  it("fills document properties from the deck title and the clock", async () => {
    const zip = await open((await buildPptx({ spec: deck(SAMPLE), now: NOW })).data);
    const core = await text(zip, "docProps/core.xml");
    expect(core).toContain("<dc:title>Quarterly review</dc:title>");
    expect(core).toContain("2026-11-12T10:00:00Z");
    expect(await text(zip, "docProps/app.xml")).toContain("<Slides>3</Slides>");
    expect(await text(zip, "ppt/presentation.xml")).toContain('<p:sldId id="258" r:id="rId9"/>');
  });

  it("drops XML-illegal control characters instead of writing a corrupt file", async () => {
    const zip = await open(
      (await buildPptx({ spec: deck({ slides: [{ title: "Bell\u0007 here", bullets: ["ok\u0001"] }] }), now: NOW })).data,
    );
    const slide = await text(zip, "ppt/slides/slide1.xml");
    expect(XMLValidator.validate(slide)).toBe(true);
    expect(slide).toContain("<a:t>Bell here</a:t>");
  });
});
