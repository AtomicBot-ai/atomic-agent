import { XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  CHART_TYPES,
  chartWorkbook,
  chartXml,
  parseChartSpec,
  sheetRef,
  type ChartSpec,
} from "./ooxml-chart.js";

const SALES: ChartSpec = {
  type: "column",
  title: "Revenue & churn",
  categories: ["Q1", "Q2", "Q3"],
  series: [
    { name: "EU", values: [10, 12.5, null] },
    { name: "US", values: [8, 9, 11] },
  ],
};

const AT_A1 = { sheet: "Sheet1", row: 1, col: 1 };

describe("chartXml", () => {
  it("writes a well-formed part for every chart type", () => {
    for (const type of CHART_TYPES) {
      const xml = chartXml({ ...SALES, type }, AT_A1, "rId1");
      expect(XMLValidator.validate(xml), type).toBe(true);
    }
  });

  it("caches categories and values and points the formulas at the data cells", () => {
    const xml = chartXml(SALES, AT_A1, "rId1");
    expect(xml).toContain('<c:barDir val="col"/>');
    expect(xml).toContain("<c:f>&apos;Sheet1&apos;!$B$1</c:f>");
    expect(xml).toContain("<c:f>&apos;Sheet1&apos;!$A$2:$A$4</c:f>");
    expect(xml).toContain("<c:f>&apos;Sheet1&apos;!$C$2:$C$4</c:f>");
    expect(xml).toContain('<c:pt idx="1"><c:v>12.5</c:v></c:pt>');
    // A null value is a gap: no point at that index.
    const firstValues = /<c:numCache>.*?<\/c:numCache>/.exec(xml)![0];
    expect(firstValues).toContain('<c:ptCount val="3"/>');
    expect(firstValues.match(/<c:pt /g)).toHaveLength(2);
    expect(xml).toContain("<a:t>Revenue &amp; churn</a:t>");
    expect(xml).toContain('<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData>');
    expect(xml).toContain('<c:legendPos val="b"/>');
  });

  it("draws horizontal bars, lines and a one-series pie", () => {
    expect(chartXml({ ...SALES, type: "bar" }, AT_A1)).toContain('<c:barDir val="bar"/>');
    const line = chartXml({ ...SALES, type: "line" }, AT_A1);
    expect(line).toContain("<c:lineChart>");
    expect(line).not.toContain("externalData");
    const pie = chartXml({ ...SALES, type: "pie" }, AT_A1);
    expect(pie).toContain('<c:pieChart><c:varyColors val="1"/>');
    expect(pie.match(/<c:ser>/g)).toHaveLength(1);
    expect(pie).not.toContain("<c:catAx>");
  });

  it("quotes a sheet name that needs it and anchors the data where it is", () => {
    expect(sheetRef("Sheet1")).toBe("'Sheet1'");
    expect(sheetRef("Q1")).toBe("'Q1'");
    expect(sheetRef("FY2026")).toBe("'FY2026'");
    expect(sheetRef("TRUE")).toBe("'TRUE'");
    expect(sheetRef("Q3 sales")).toBe("'Q3 sales'");
    expect(sheetRef("Bob's")).toBe("'Bob''s'");
    const xml = chartXml(SALES, { sheet: "Q3 sales", row: 4, col: 2 });
    expect(xml).toContain("<c:f>&apos;Q3 sales&apos;!$C$5:$C$7</c:f>");
    expect(xml).toContain("<c:f>&apos;Q3 sales&apos;!$B$5:$B$7</c:f>");
  });
});

describe("chartWorkbook", () => {
  it("holds the data at A1 with the series names as headers", async () => {
    const zip = await JSZip.loadAsync(await chartWorkbook(SALES));
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("text");
    expect(XMLValidator.validate(sheet)).toBe(true);
    expect(sheet).toContain('<c r="B1" t="inlineStr"><is><t xml:space="preserve">EU</t></is></c>');
    expect(sheet).toContain('<c r="A3" t="inlineStr"><is><t xml:space="preserve">Q2</t></is></c>');
    expect(sheet).toContain('<c r="B3"><v>12.5</v></c>');
    expect(sheet).not.toContain('r="B4"');
    for (const part of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml"]) {
      const xml = await zip.file(part)!.async("text");
      expect(XMLValidator.validate(xml), part).toBe(true);
    }
  });
});

describe("parseChartSpec", () => {
  it("reads a chart as a model sends it", () => {
    expect(
      parseChartSpec({ type: "Pie", categories: ["A", 2], series: [{ name: "", values: ["3", null] }] }, "x."),
    ).toEqual({ type: "pie", categories: ["A", "2"], series: [{ name: "Series 1", values: [3, null] }] });
  });

  it("refuses what cannot be drawn", () => {
    expect(() => parseChartSpec({ type: "radar", categories: ["A"], series: [{ name: "s", values: [1] }] }, "x.")).toThrow(/type must be one of/);
    expect(() => parseChartSpec({ type: "line", categories: [], series: [] }, "x.")).toThrow(/categories must be a non-empty/);
    expect(() => parseChartSpec({ type: "line", categories: ["A"], series: [] }, "x.")).toThrow(/series must be a non-empty/);
    expect(() => parseChartSpec({ type: "line", categories: ["A"], series: [{ name: "s", values: [1, 2] }] }, "x.")).toThrow(/2 numbers for 1 categories/);
    expect(() => parseChartSpec({ type: "line", categories: ["A"], series: [{ name: "s", values: ["ten"] }] }, "x.")).toThrow(/values\[0\] must be a number/);
  });
});
