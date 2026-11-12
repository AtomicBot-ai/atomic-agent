import type { Extractor } from "./extractor-types.js";
import {
  nodeAttr,
  nodeChildren,
  nodeTag,
  odfInlineText,
  openZip,
  parseXmlRaw,
  readZipText,
  type XmlNode,
} from "./zip-xml-helpers.js";

/**
 * ODS (LibreOffice Calc) extractor. An ODS file is a Zip with the sheets in
 * `content.xml` as `table:table` elements. Output matches the XLSX
 * extractor so the model sees one shape for both spreadsheet formats:
 *
 *     ## Sheet: Revenue
 *     Quarter | Amount
 *     Q1 | 1200
 *
 * ODF compresses runs of identical cells and rows with
 * `table:number-columns-repeated` / `table:number-rows-repeated`, and every
 * real-world file ends a row with one empty cell repeated ~16k times and a
 * sheet with an empty row repeated ~1M times. Empty runs are therefore
 * never materialised: trailing ones are dropped, inner ones are expanded
 * only up to a small cap. Repeated non-empty rows are expanded up to
 * `MAX_REPEAT` so a deliberately repeated row is still visible.
 *
 * The displayed text (`text:p`) is used for every cell, so numbers, dates
 * and currencies read the way the user sees them in Calc.
 */
const MAX_REPEAT = 1000;

export const odsExtractor: Extractor = async (input) => {
  const warnings: string[] = [];
  const zip = await openZip(input.data);
  const contentXml = await readZipText(zip, "content.xml");
  if (!contentXml) {
    return { format: "ods", text: "", sheetCount: 0, warnings: ["content.xml missing"] };
  }
  const tables: XmlNode[] = [];
  collectTables(parseXmlRaw(contentXml), tables);

  const selected = selectSheets(tables, input.sheets, warnings);
  const showHeader = input.pageSeparators !== false;
  const parts: string[] = [];
  for (const { table, name } of selected) {
    if (showHeader) parts.push(`## Sheet: ${name}`);
    const rows = renderTable(table, warnings, name);
    if (rows.length > 0) parts.push(rows);
  }
  return {
    format: "ods",
    text: parts.join("\n\n").trim(),
    sheetCount: tables.length,
    pagesExtracted: selected.map((s) => s.index),
    warnings,
  };
};

/** Top-level sheets only: a `table:table` never nests inside another sheet. */
function collectTables(nodes: XmlNode[], out: XmlNode[]): void {
  for (const item of nodes) {
    const tag = nodeTag(item);
    if (!tag || tag === "#text") continue;
    if (tag === "table:table") {
      out.push(item);
      continue;
    }
    collectTables(nodeChildren(item, tag), out);
  }
}

function sheetName(table: XmlNode, index: number): string {
  return nodeAttr(table, "table:name") ?? `Sheet${index}`;
}

function selectSheets(
  tables: XmlNode[],
  requested: readonly (string | number)[] | undefined,
  warnings: string[],
): { table: XmlNode; name: string; index: number }[] {
  const all = tables.map((table, i) => ({
    table,
    name: sheetName(table, i + 1),
    index: i + 1,
  }));
  if (!requested || requested.length === 0) return all;
  const picked: typeof all = [];
  for (const entry of requested) {
    const hit =
      typeof entry === "number"
        ? all[entry - 1]
        : all.find((s) => s.name === entry) ??
          all.find((s) => s.name.toLowerCase() === String(entry).toLowerCase());
    if (!hit) {
      warnings.push(`sheet ${JSON.stringify(entry)} not found`);
      continue;
    }
    if (!picked.includes(hit)) picked.push(hit);
  }
  return picked;
}

function repeatCount(item: XmlNode, attr: string): number {
  const n = parseInt(nodeAttr(item, attr) ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function renderTable(table: XmlNode, warnings: string[], name: string): string {
  const lines: string[] = [];
  let clipped = false;
  const rows: XmlNode[] = [];
  collectRows(nodeChildren(table, "table:table"), rows);
  for (const row of rows) {
    const cells = renderRow(row);
    const repeat = repeatCount(row, "table:number-rows-repeated");
    // Blank rows (including the ~1M trailing padding rows) are skipped,
    // same as the XLSX extractor.
    if (cells.length === 0) continue;
    const line = cells.join(" | ");
    const times = Math.min(repeat, MAX_REPEAT);
    if (repeat > MAX_REPEAT) clipped = true;
    for (let i = 0; i < times; i++) lines.push(line);
  }
  if (clipped) {
    warnings.push(`sheet "${name}": a repeated row was shown ${MAX_REPEAT} times only`);
  }
  return lines.join("\n");
}

/** Rows can sit inside `table:table-rows`, header-row and row-group wrappers. */
function collectRows(nodes: XmlNode[], out: XmlNode[]): void {
  for (const item of nodes) {
    const tag = nodeTag(item);
    if (!tag || tag === "#text") continue;
    if (tag === "table:table-row") {
      out.push(item);
      continue;
    }
    if (
      tag === "table:table-rows" ||
      tag === "table:table-header-rows" ||
      tag === "table:table-row-group"
    ) {
      collectRows(nodeChildren(item, tag), out);
    }
  }
}

function renderRow(row: XmlNode): string[] {
  const out: string[] = [];
  let pendingEmpty = 0;
  for (const cell of nodeChildren(row, "table:table-row")) {
    const tag = nodeTag(cell);
    if (tag !== "table:table-cell" && tag !== "table:covered-table-cell") continue;
    const repeat = repeatCount(cell, "table:number-columns-repeated");
    const text = cellText(cell, tag);
    if (text.length === 0) {
      pendingEmpty += repeat;
      continue;
    }
    // Materialise the gap only now that a value follows it, so a row that
    // ends in 16k empty cells costs nothing.
    for (let i = 0; i < Math.min(pendingEmpty, MAX_REPEAT); i++) out.push("");
    pendingEmpty = 0;
    for (let i = 0; i < Math.min(repeat, MAX_REPEAT); i++) out.push(text);
  }
  return out;
}

function cellText(cell: XmlNode, tag: string): string {
  const paragraphs: string[] = [];
  for (const child of nodeChildren(cell, tag)) {
    const childTag = nodeTag(child);
    if (childTag === "text:p" || childTag === "text:h") {
      paragraphs.push(odfInlineText(nodeChildren(child, childTag)));
    }
  }
  const shown = paragraphs.join(" ").replace(/\s*\n\s*/g, " ").trim();
  if (shown.length > 0) return shown;
  // A cell written by a generator without the display paragraph still
  // carries its typed value as an attribute.
  return (
    nodeAttr(cell, "office:value") ??
    nodeAttr(cell, "office:date-value") ??
    nodeAttr(cell, "office:string-value") ??
    ""
  ).trim();
}
