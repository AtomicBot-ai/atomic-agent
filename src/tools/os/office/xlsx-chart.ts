import type * as ExcelJS from "exceljs";
import JSZip from "jszip";

import { chartReference, chartXml, type ChartSpec, type ChartType } from "../ooxml/ooxml-chart.js";
import {
  CT,
  addOverride,
  addRelationship,
  nextFreePartName,
  packZip,
  readPart,
  relativeTarget,
  relsPathOf,
  resolveTarget,
} from "../ooxml/ooxml-package.js";
import { decodeXmlText } from "./docx-xml.js";
import { columnLetters, parseCellRef } from "./xlsx-ops.js";

/**
 * `os.fs.xlsx` op `chart`: a native Excel chart over a block of cells,
 * added to the package directly (exceljs reads and writes cells but has
 * no charts). The parts are the ones Excel and openpyxl write: a chart
 * part, a drawing part anchoring it to cells, the sheet's `<drawing>`
 * pointing at the drawing, and their relationships and content types.
 * The sheet's cells are left byte for byte as they were.
 *
 * The data block is laid out the usual way: a header row with the series
 * names, the categories down its first column, one column per series.
 */

export interface ChartRequest {
  type: ChartType;
  title?: string;
  /** Like `A1:C5`: header row and category column included. */
  range: string;
  sheet?: string;
  /** Top-left cell of the chart; default two columns right of the data. */
  anchor?: string;
}

export interface ChartPlacement {
  sheetName: string;
  /** The data block, normalised (`A1:C5`). */
  range: string;
  anchor: string;
  chartPart: string;
  series: number;
  points: number;
}

/** Columns and rows a chart covers on the sheet (Excel's default size is about 8 × 15). */
const CHART_COLS = 8;
const CHART_ROWS = 15;

export function parseRange(range: string): { r0: number; c0: number; r1: number; c1: number } {
  const [a, b] = range.split(":");
  const top = parseCellRef(a ?? "");
  const bottom = b === undefined ? top : parseCellRef(b);
  return {
    r0: Math.min(top.row, bottom.row),
    c0: Math.min(top.col, bottom.col),
    r1: Math.max(top.row, bottom.row),
    c1: Math.max(top.col, bottom.col),
  };
}

function cellNumber(value: ExcelJS.CellValue): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value !== null && typeof value === "object" && "result" in value) {
    const result = (value as { result?: unknown }).result;
    return typeof result === "number" && Number.isFinite(result) ? result : null;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((p) => p.text).join("");
    if ("result" in value) return value.result === undefined || value.result === null ? "" : String(value.result);
    if ("text" in value && typeof value.text === "string") return value.text;
  }
  return String(value);
}

/** The chart's categories and series as the sheet holds them now (the cached values the part carries). */
export function chartDataFromSheet(
  sheet: ExcelJS.Worksheet,
  request: Pick<ChartRequest, "type" | "title" | "range">,
): ChartSpec {
  const { r0, c0, r1, c1 } = parseRange(request.range);
  if (r1 - r0 < 1 || c1 - c0 < 1) {
    throw new Error(
      `range ${request.range} needs a header row and at least one row of data, and a category column plus at least one series column`,
    );
  }
  const categories: string[] = [];
  for (let r = r0 + 1; r <= r1; r += 1) categories.push(cellText(sheet.getCell(r, c0).value));
  const series: ChartSpec["series"] = [];
  for (let c = c0 + 1; c <= c1; c += 1) {
    const name = cellText(sheet.getCell(r0, c).value) || `Series ${c - c0}`;
    const values: (number | null)[] = [];
    for (let r = r0 + 1; r <= r1; r += 1) values.push(cellNumber(sheet.getCell(r, c).value));
    series.push({ name, values });
  }
  if (series.every((s) => s.values.every((v) => v === null))) {
    throw new Error(`range ${request.range} has no numbers to chart below its header row`);
  }
  return { type: request.type, categories, series, ...(request.title === undefined ? {} : { title: request.title }) };
}

const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";

async function workbookPart(zip: JSZip): Promise<string> {
  const rels = await readPart(zip, "_rels/.rels");
  const target = rels
    ?.match(/<Relationship\b[^>]*Type="[^"]*\/officeDocument"[^>]*>/)?.[0]
    ?.match(/Target="([^"]+)"/)?.[1];
  const path = resolveTarget("", target ?? "xl/workbook.xml");
  if (zip.file(path) === null) throw new Error("not an Excel workbook: no workbook part");
  return path;
}

/** The sheet's part and its name: the one named, or the first. */
async function sheetPart(zip: JSZip, wanted: string | undefined): Promise<{ path: string; name: string }> {
  const workbook = await workbookPart(zip);
  const xml = (await readPart(zip, workbook)) ?? "";
  const sheets = [...xml.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: decodeXmlText(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? ""),
    relId: /\b[A-Za-z0-9]+:id="([^"]+)"/.exec(m[0])?.[1],
  }));
  const sheet = wanted === undefined ? sheets[0] : sheets.find((s) => s.name === wanted);
  if (sheet?.relId === undefined) {
    throw new Error(
      wanted === undefined
        ? "the workbook has no sheets"
        : `no sheet named ${JSON.stringify(wanted)} (sheets: ${sheets.map((s) => s.name).join(", ") || "none"})`,
    );
  }
  const rels = (await readPart(zip, relsPathOf(workbook))) ?? "";
  const tag = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(`Id="${sheet.relId}"`));
  const target = tag?.match(/Target="([^"]+)"/)?.[1];
  if (target === undefined) throw new Error(`the workbook does not say where sheet ${sheet.name} is`);
  const path = resolveTarget(workbook, target);
  if (zip.file(path) === null) throw new Error(`the part of sheet ${sheet.name} is missing`);
  return { path, name: sheet.name };
}

/** Elements that follow `<drawing>` in a worksheet (CT_Worksheet order). */
const AFTER_DRAWING = ["<legacyDrawing", "<legacyDrawingHF", "<drawingHF", "<picture", "<oleObjects", "<controls", "<webPublishItems", "<tableParts"];

/** Offset of the worksheet's own `<extLst>` (its last child), or -1; one inside another element is skipped. */
function topLevelExtLst(xml: string, end: number): number {
  for (let at = xml.indexOf("<extLst", 0); at >= 0 && at < end; at = xml.indexOf("<extLst", at + 1)) {
    let depth = 0;
    const tags = /<extLst\b[^>]*?(\/?)>|<\/extLst>/g;
    tags.lastIndex = at;
    let match: RegExpExecArray | null;
    let close = -1;
    while ((match = tags.exec(xml)) !== null && match.index < end) {
      if (match[0].startsWith("</")) depth -= 1;
      else if (match[1] !== "/") depth += 1;
      if (depth === 0) {
        close = match.index + match[0].length;
        break;
      }
    }
    if (close >= 0 && xml.slice(close, end).trim() === "") return at;
  }
  return -1;
}

/** Put `<drawing r:id>` where the schema wants it, and declare the `r` prefix on the root if needed. */
export function insertDrawingElement(sheetXml: string, relId: string): string {
  const end = sheetXml.lastIndexOf("</worksheet>");
  if (end < 0) throw new Error("the sheet part is not a worksheet");
  const after = sheetXml.indexOf("</sheetData>");
  const candidates = AFTER_DRAWING.map((tag) => sheetXml.indexOf(tag, Math.max(after, 0))).filter((i) => i >= 0);
  const ext = topLevelExtLst(sheetXml, end);
  if (ext >= 0) candidates.push(ext);
  const at = candidates.length > 0 ? Math.min(...candidates) : end;
  let out = sheetXml.slice(0, at) + `<drawing r:id="${relId}"/>` + sheetXml.slice(at);
  const root = /<worksheet\b[^>]*>/.exec(out);
  if (root !== null && !/\bxmlns:r=/.test(root[0])) {
    const tag = root[0].replace(/<worksheet\b/, `<worksheet xmlns:r="${NS_R}"`);
    out = out.slice(0, root.index) + tag + out.slice(root.index + root[0].length);
  }
  return out;
}

function anchorXml(id: number, relId: string, anchor: { row: number; col: number }): string {
  const marker = (tag: string, col: number, row: number) =>
    `<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${tag}>`;
  return (
    '<xdr:twoCellAnchor editAs="oneCell">' +
    marker("from", anchor.col - 1, anchor.row - 1) +
    marker("to", anchor.col - 1 + CHART_COLS, anchor.row - 1 + CHART_ROWS) +
    `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="Chart ${id - 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
    chartReference(relId) +
    "</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>"
  );
}

/**
 * Add a chart of `spec` to the workbook `data`, its data at `range` on
 * the sheet. A sheet that already has a drawing (pictures, other
 * charts) gets the chart added to that drawing.
 */
export async function addChartToXlsx(
  data: Buffer,
  spec: ChartSpec,
  request: ChartRequest,
): Promise<{ data: Buffer; placement: ChartPlacement }> {
  const zip = await JSZip.loadAsync(data);
  const sheet = await sheetPart(zip, request.sheet);
  const { r0, c0, r1, c1 } = parseRange(request.range);
  const anchor = request.anchor === undefined ? { row: r0, col: c1 + 2 } : parseCellRef(request.anchor);

  let sheetXml = (await readPart(zip, sheet.path)) ?? "";
  const existingDrawing = /<drawing\b[^>]*\b[A-Za-z0-9]+:id="([^"]+)"/.exec(sheetXml)?.[1];
  let drawingPath: string | undefined;
  if (existingDrawing !== undefined) {
    const rels = (await readPart(zip, relsPathOf(sheet.path))) ?? "";
    const tag = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(`Id="${existingDrawing}"`));
    const target = tag?.match(/Target="([^"]+)"/)?.[1];
    if (target !== undefined) drawingPath = resolveTarget(sheet.path, target);
  }
  let drawingXml: string;
  if (drawingPath !== undefined && zip.file(drawingPath) !== null) {
    drawingXml = (await readPart(zip, drawingPath)) ?? "";
  } else {
    drawingPath = nextFreePartName(zip, (n) => `xl/drawings/drawing${n}.xml`);
    drawingXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"></xdr:wsDr>`;
    const relId = await addRelationship(zip, sheet.path, "drawing", relativeTarget(sheet.path, drawingPath));
    sheetXml = insertDrawingElement(sheetXml, relId);
    zip.file(sheet.path, sheetXml);
    await addOverride(zip, drawingPath, CT.drawing);
  }

  const chartPart = nextFreePartName(zip, (n) => `xl/charts/chart${n}.xml`);
  zip.file(chartPart, chartXml(spec, { sheet: sheet.name, row: r0, col: c0 }));
  await addOverride(zip, chartPart, CT.chart);
  const chartRel = await addRelationship(zip, drawingPath, "chart", relativeTarget(drawingPath, chartPart));

  const nextId = Math.max(1, ...[...drawingXml.matchAll(/<xdr:cNvPr\b[^>]*\bid="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  // An existing drawing may name its prefixes differently; ours is
  // self-contained, so its namespaces are declared on the anchor.
  const end = drawingXml.lastIndexOf("</xdr:wsDr>");
  if (end < 0) throw new Error("the sheet's drawing part is not a spreadsheet drawing this tool can extend");
  const ns = drawingXml.includes(`xmlns:a="${NS_A}"`) && drawingXml.includes(`xmlns:r="${NS_R}"`) ? "" : ` xmlns:a="${NS_A}" xmlns:r="${NS_R}"`;
  const anchorPart = anchorXml(nextId, chartRel, anchor).replace("<xdr:twoCellAnchor ", `<xdr:twoCellAnchor${ns} `);
  zip.file(drawingPath, drawingXml.slice(0, end) + anchorPart + drawingXml.slice(end));

  return {
    data: await packZip(zip),
    placement: {
      sheetName: sheet.name,
      range: `${columnLetters(c0)}${r0}:${columnLetters(c1)}${r1}`,
      anchor: `${columnLetters(anchor.col)}${anchor.row}`,
      chartPart,
      series: spec.type === "pie" ? 1 : spec.series.length,
      points: spec.categories.length,
    },
  };
}

/** True when the workbook carries chart parts (which a cell write through exceljs would drop). */
export async function hasCharts(data: Buffer): Promise<boolean> {
  const zip = await JSZip.loadAsync(data);
  return Object.keys(zip.files).some((name) => /^xl\/charts\/chart\d*\.xml$/i.test(name));
}

