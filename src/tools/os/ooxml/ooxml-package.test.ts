import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  addDefault,
  addOverride,
  addRelationship,
  escapeXml,
  nextFreePartName,
  relationshipsXml,
  relativeTarget,
  relsPathOf,
  resolveTarget,
} from "./ooxml-package.js";

const TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/></Types>';

describe("ooxml package helpers", () => {
  it("names rels parts and resolves targets both ways", () => {
    expect(relsPathOf("ppt/slides/slide1.xml")).toBe("ppt/slides/_rels/slide1.xml.rels");
    expect(relsPathOf("[Content_Types].xml")).toBe("_rels/[Content_Types].xml.rels");
    expect(resolveTarget("ppt/slides/slide1.xml", "../charts/chart1.xml")).toBe("ppt/charts/chart1.xml");
    expect(resolveTarget("xl/worksheets/sheet1.xml", "/xl/drawings/drawing1.xml")).toBe("xl/drawings/drawing1.xml");
    expect(relativeTarget("xl/worksheets/sheet1.xml", "xl/drawings/drawing1.xml")).toBe("../drawings/drawing1.xml");
    expect(relativeTarget("word/document.xml", "word/numbering.xml")).toBe("numbering.xml");
  });

  it("adds a relationship with the first free id and reuses an identical one", async () => {
    const zip = new JSZip();
    expect(await addRelationship(zip, "word/document.xml", "styles", "styles.xml")).toBe("rId1");
    zip.file(
      "word/_rels/document.xml.rels",
      relationshipsXml([
        { id: "rId1", type: "styles", target: "styles.xml" },
        { id: "rId3", type: "settings", target: "settings.xml" },
      ]),
    );
    expect(await addRelationship(zip, "word/document.xml", "numbering", "numbering.xml")).toBe("rId2");
    expect(await addRelationship(zip, "word/document.xml", "numbering", "numbering.xml")).toBe("rId2");
    const rels = await zip.file("word/_rels/document.xml.rels")!.async("text");
    expect(rels.match(/numbering\.xml/g)).toHaveLength(1);
    expect(rels).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"',
    );
  });

  it("types a part or an extension once", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", TYPES);
    await addOverride(zip, "xl/charts/chart1.xml", "application/vnd.openxmlformats-officedocument.drawingml.chart+xml");
    await addOverride(zip, "/xl/charts/chart1.xml", "application/vnd.openxmlformats-officedocument.drawingml.chart+xml");
    await addDefault(zip, "png", "image/png");
    await addDefault(zip, ".PNG", "image/png");
    await addDefault(zip, "xml", "text/xml");
    const types = await zip.file("[Content_Types].xml")!.async("text");
    expect(types.match(/PartName="\/xl\/charts\/chart1\.xml"/g)).toHaveLength(1);
    expect(types.match(/Extension="png"/g)).toHaveLength(1);
    // An extension already typed keeps its type.
    expect(types).toContain('<Default Extension="xml" ContentType="application/xml"/>');
    expect(types.endsWith("</Types>")).toBe(true);
  });

  it("finds the next free part name and escapes text for XML", () => {
    const zip = new JSZip();
    zip.file("ppt/charts/chart1.xml", "");
    zip.file("ppt/charts/chart2.xml", "");
    expect(nextFreePartName(zip, (n) => `ppt/charts/chart${n}.xml`)).toBe("ppt/charts/chart3.xml");
    expect(escapeXml("a & <b> \"c\" 'd'\u0007")).toBe("a &amp; &lt;b&gt; &quot;c&quot; &apos;d&apos;");
  });
});
