import JSZip from "jszip";
import { CT, XML_HEAD, escapeXml, packZip, relationshipsXml } from "./ooxml-package.js";

/**
 * A simple DrawingML chart part (`c:chartSpace`, ECMA-376 part 1 §21.2)
 * shared by the Office writers: a PowerPoint slide and an Excel sheet
 * both point at the same kind of part, only the frame around it
 * differs. Column, bar, line and pie, one to a few series over one list
 * of categories, the way python-pptx's `ChartData` / openpyxl's
 * `BarChart` lay a chart out.
 *
 * The numbers are cached in the part itself (`c:strCache` /
 * `c:numCache`), so every viewer draws the chart without a spreadsheet;
 * the `c:f` formulas name the cells the data lives in (the deck's
 * embedded workbook, or the sheet itself), so "Edit Data" in PowerPoint
 * and Excel opens them.
 */

export const CHART_TYPES = ["column", "bar", "line", "pie"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface ChartSeries {
  name: string;
  /** null leaves a gap. */
  values: (number | null)[];
}

export interface ChartSpec {
  type: ChartType;
  title?: string;
  categories: string[];
  series: ChartSeries[];
}

export const MAX_CHART_SERIES = 12;
export const MAX_CHART_POINTS = 500;

/**
 * Where the chart's data sits in a sheet: a header row with the series
 * names, the categories down the first column under it, one column per
 * series to its right. 1-based, like A1 references.
 */
export interface ChartDataLayout {
  sheet: string;
  row: number;
  col: number;
}

const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export function columnName(col: number): string {
  let out = "";
  let n = col;
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** `Sheet1` stays bare; `Q3 sales` becomes `'Q3 sales'`, an apostrophe doubled. */
export function sheetRef(sheet: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`;
}

function cell(layout: ChartDataLayout, rowOffset: number, colOffset: number): string {
  return `$${columnName(layout.col + colOffset)}$${layout.row + rowOffset}`;
}

function range(layout: ChartDataLayout, colOffset: number, count: number): string {
  const from = cell(layout, 1, colOffset);
  const to = cell(layout, count, colOffset);
  return `${sheetRef(layout.sheet)}!${from}:${to}`;
}

function strCache(values: readonly string[]): string {
  return (
    `<c:strCache><c:ptCount val="${values.length}"/>` +
    values.map((v, i) => `<c:pt idx="${i}"><c:v>${escapeXml(v)}</c:v></c:pt>`).join("") +
    "</c:strCache>"
  );
}

function numCache(values: readonly (number | null)[]): string {
  return (
    `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>` +
    values
      .map((v, i) => (v === null ? "" : `<c:pt idx="${i}"><c:v>${String(v)}</c:v></c:pt>`))
      .join("") +
    "</c:numCache>"
  );
}

function seriesXml(spec: ChartSpec, layout: ChartDataLayout, index: number): string {
  const series = spec.series[index]!;
  const n = spec.categories.length;
  const values = Array.from({ length: n }, (_, i) => series.values[i] ?? null);
  const tx = `<c:tx><c:strRef><c:f>${escapeXml(`${sheetRef(layout.sheet)}!${cell(layout, 0, index + 1)}`)}</c:f>${strCache([series.name])}</c:strRef></c:tx>`;
  const cat = `<c:cat><c:strRef><c:f>${escapeXml(range(layout, 0, n))}</c:f>${strCache(spec.categories)}</c:strRef></c:cat>`;
  const val = `<c:val><c:numRef><c:f>${escapeXml(range(layout, index + 1, n))}</c:f>${numCache(values)}</c:numRef></c:val>`;
  // Child order is fixed by the schema (CT_BarSer, CT_LineSer, CT_PieSer).
  const head = `<c:idx val="${index}"/><c:order val="${index}"/>${tx}`;
  switch (spec.type) {
    case "column":
    case "bar":
      return `<c:ser>${head}<c:invertIfNegative val="0"/>${cat}${val}</c:ser>`;
    case "line":
      return `<c:ser>${head}<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>${cat}${val}<c:smooth val="0"/></c:ser>`;
    case "pie":
      return `<c:ser>${head}${cat}${val}</c:ser>`;
  }
}

const CAT_AX_ID = 50_010_001;
const VAL_AX_ID = 50_010_002;

function axes(horizontal: boolean): string {
  const catPos = horizontal ? "l" : "b";
  const valPos = horizontal ? "b" : "l";
  return (
    `<c:catAx><c:axId val="${CAT_AX_ID}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${catPos}"/>` +
    '<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
    `<c:crossAx val="${VAL_AX_ID}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
    `<c:valAx><c:axId val="${VAL_AX_ID}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${valPos}"/><c:majorGridlines/>` +
    '<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
    `<c:crossAx val="${CAT_AX_ID}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`
  );
}

function plotXml(spec: ChartSpec, layout: ChartDataLayout): string {
  const ids = `<c:axId val="${CAT_AX_ID}"/><c:axId val="${VAL_AX_ID}"/>`;
  // A pie shows one series: the first.
  const count = spec.type === "pie" ? 1 : spec.series.length;
  const series = Array.from({ length: count }, (_, i) => seriesXml(spec, layout, i)).join("");
  switch (spec.type) {
    case "column":
    case "bar":
      return (
        `<c:barChart><c:barDir val="${spec.type === "bar" ? "bar" : "col"}"/><c:grouping val="clustered"/><c:varyColors val="0"/>` +
        `${series}<c:gapWidth val="150"/>${ids}</c:barChart>` +
        axes(spec.type === "bar")
      );
    case "line":
      return `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/>${ids}</c:lineChart>${axes(false)}`;
    case "pie":
      return `<c:pieChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/></c:pieChart>`;
  }
}

function titleXml(title: string): string {
  return (
    "<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/>" +
    `<a:p><a:pPr><a:defRPr b="1"/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>${escapeXml(title)}</a:t></a:r></a:p>` +
    '</c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>'
  );
}

/**
 * The chart part. `externalDataRelId` points at an embedded workbook
 * (a deck); a chart inside a workbook reads its own sheet and has none.
 */
export function chartXml(
  spec: ChartSpec,
  layout: ChartDataLayout,
  externalDataRelId?: string,
): string {
  const title = spec.title === undefined ? '<c:autoTitleDeleted val="1"/>' : titleXml(spec.title);
  const legend = spec.type === "pie" || spec.series.length > 1
    ? `<c:legend><c:legendPos val="${spec.type === "pie" ? "r" : "b"}"/><c:overlay val="0"/></c:legend>`
    : "";
  const external =
    externalDataRelId === undefined
      ? ""
      : `<c:externalData r:id="${externalDataRelId}"><c:autoUpdate val="0"/></c:externalData>`;
  return (
    XML_HEAD +
    `<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">` +
    '<c:date1904 val="0"/><c:roundedCorners val="0"/>' +
    `<c:chart>${title}<c:plotArea><c:layout/>${plotXml(spec, layout)}</c:plotArea>${legend}` +
    '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>' +
    external +
    "</c:chartSpace>"
  );
}

/** The `<c:chart r:id>` reference a slide's or a drawing's graphic frame carries. */
export function chartReference(relId: string): string {
  return (
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
    `<c:chart xmlns:c="${NS_C}" r:id="${relId}"/>` +
    "</a:graphicData></a:graphic>"
  );
}

const SML_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const SML_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml";

const MINIMAL_STYLES =
  XML_HEAD +
  `<styleSheet xmlns="${SML_NS}">` +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

/** The sheet name {@link chartWorkbook} puts the data on. */
export const CHART_WORKBOOK_SHEET = "Sheet1";

/**
 * A one-sheet workbook holding a chart's data at A1 in the
 * {@link ChartDataLayout} shape: what PowerPoint opens on "Edit Data".
 * Hand-written (inline strings, no shared-strings part) so the bytes
 * depend on the data only.
 */
export async function chartWorkbook(spec: ChartSpec): Promise<Buffer> {
  const text = (ref: string, value: string) =>
    `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  const rows: string[] = [];
  const header = [text("A1", ""), ...spec.series.map((s, i) => text(`${columnName(i + 2)}1`, s.name))];
  rows.push(`<row r="1">${header.join("")}</row>`);
  spec.categories.forEach((category, r) => {
    const n = r + 2;
    const cells = [text(`A${n}`, category)];
    spec.series.forEach((s, i) => {
      const v = s.values[r];
      if (typeof v === "number") cells.push(`<c r="${columnName(i + 2)}${n}"><v>${String(v)}</v></c>`);
    });
    rows.push(`<row r="${n}">${cells.join("")}</row>`);
  });
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      `<Default Extension="rels" ContentType="${CT.rels}"/><Default Extension="xml" ContentType="${CT.xml}"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="${SML_CT}.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${SML_CT}.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="${SML_CT}.styles+xml"/>` +
      "</Types>",
  );
  zip.file("_rels/.rels", relationshipsXml([{ id: "rId1", type: "officeDocument", target: "xl/workbook.xml" }]));
  zip.file(
    "xl/workbook.xml",
    XML_HEAD +
      `<workbook xmlns="${SML_NS}" xmlns:r="${NS_R}"><sheets><sheet name="${CHART_WORKBOOK_SHEET}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    relationshipsXml([
      { id: "rId1", type: "worksheet", target: "worksheets/sheet1.xml" },
      { id: "rId2", type: "styles", target: "styles.xml" },
    ]),
  );
  zip.file("xl/styles.xml", MINIMAL_STYLES);
  zip.file("xl/worksheets/sheet1.xml", XML_HEAD + `<worksheet xmlns="${SML_NS}"><sheetData>${rows.join("")}</sheetData></worksheet>`);
  return packZip(zip);
}

/**
 * Validate a chart as a model sends it (`{ type, title?, categories,
 * series: [{ name, values }] }`). `where` prefixes every message
 * (`os.fs.write_pptx: slides[2].chart.`).
 */
export function parseChartSpec(raw: unknown, where: string): ChartSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} must be an object { type, categories, series }`);
  }
  const obj = raw as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type.trim().toLowerCase() : "column";
  if (!(CHART_TYPES as readonly string[]).includes(type)) {
    throw new Error(`${where}type must be one of ${CHART_TYPES.join(", ")} (column = vertical bars, bar = horizontal)`);
  }
  if (!Array.isArray(obj.categories) || obj.categories.length === 0) {
    throw new Error(`${where}categories must be a non-empty array of labels`);
  }
  if (obj.categories.length > MAX_CHART_POINTS) {
    throw new Error(`${where}categories has ${obj.categories.length} items; at most ${MAX_CHART_POINTS}`);
  }
  const categories = obj.categories.map((c: unknown, i: number) => {
    if (typeof c === "string") return c;
    if (typeof c === "number" && Number.isFinite(c)) return String(c);
    throw new Error(`${where}categories[${i}] must be a string or a number`);
  });
  if (!Array.isArray(obj.series) || obj.series.length === 0) {
    throw new Error(`${where}series must be a non-empty array of { name, values }`);
  }
  if (obj.series.length > MAX_CHART_SERIES) {
    throw new Error(`${where}series has ${obj.series.length} items; at most ${MAX_CHART_SERIES}`);
  }
  const series = obj.series.map((s: unknown, i: number): ChartSeries => {
    const at = `${where}series[${i}].`;
    if (typeof s !== "object" || s === null || Array.isArray(s)) {
      throw new Error(`${where}series[${i}] must be an object { name, values }`);
    }
    const entry = s as Record<string, unknown>;
    const name = typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name : `Series ${i + 1}`;
    if (!Array.isArray(entry.values)) throw new Error(`${at}values must be an array of numbers`);
    if (entry.values.length > categories.length) {
      throw new Error(`${at}values has ${entry.values.length} numbers for ${categories.length} categories`);
    }
    const values = entry.values.map((v: unknown, n: number) => {
      if (v === null) return null;
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
      throw new Error(`${at}values[${n}] must be a number (or null for a gap)`);
    });
    return { name, values };
  });
  const title = typeof obj.title === "string" && obj.title.trim().length > 0 ? obj.title.trim() : undefined;
  return { type: type as ChartType, categories, series, ...(title === undefined ? {} : { title }) };
}
