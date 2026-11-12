import type * as ExcelJS from "exceljs";

/**
 * Spreadsheet operations behind `os.fs.xlsx`, on exceljs (already a
 * runtime dependency: the document reader uses it). Values go in as a
 * block of rows anchored at a cell; a string starting with `=` is a
 * formula, `'=` keeps a literal leading `=`, `null` clears a cell.
 *
 * exceljs writes formulas without a computed value, so every saved
 * workbook asks the opening app to recalculate (`fullCalcOnLoad`):
 * Excel, Numbers and LibreOffice show the results; `read` here shows the
 * formula itself (and its cached value when the file has one).
 */

export type CellInput = string | number | boolean | null;

export interface WriteBlock {
  sheet?: string;
  cell: string;
  rows: readonly (readonly CellInput[])[];
  bold?: boolean;
  numFmt?: string;
}

/** Most cells one `read` renders; a bigger range is cut with a note. */
export const READ_MAX_ROWS = 200;
export const READ_MAX_COLS = 50;

type ExcelJsModule = typeof ExcelJS;
let excelJs: ExcelJsModule | undefined;
export async function loadExcelJs(): Promise<ExcelJsModule> {
  if (!excelJs) {
    const mod = (await import("exceljs")) as ExcelJsModule | { default: ExcelJsModule };
    excelJs = "default" in mod ? mod.default : mod;
  }
  return excelJs;
}

export async function openWorkbook(data?: Buffer): Promise<ExcelJS.Workbook> {
  const { Workbook } = await loadExcelJs();
  const workbook = new Workbook();
  if (data !== undefined) {
    // A standalone ArrayBuffer: a Node Buffer may be a view into a shared pool.
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    await workbook.xlsx.load(copy.buffer);
  }
  return workbook;
}

export async function saveWorkbook(workbook: ExcelJS.Workbook): Promise<Buffer> {
  workbook.calcProperties.fullCalcOnLoad = true;
  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

/** `B3` → `{ row: 3, col: 2 }`. `$` anchors are accepted and ignored. */
export function parseCellRef(ref: string): { row: number; col: number } {
  const match = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/.exec(ref.trim());
  if (!match) throw new Error(`not a cell reference: ${JSON.stringify(ref)} (expected like A1 or C12)`);
  let col = 0;
  for (const ch of match[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  if (col > 16384) throw new Error(`column out of range in ${ref}`);
  return { row: Number(match[2]), col };
}

export function columnLetters(col: number): string {
  let out = "";
  let n = col;
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** The sheet named, or the first one; `create` makes a missing named sheet. */
export function pickSheet(
  workbook: ExcelJS.Workbook,
  name: string | undefined,
  create: boolean,
): { sheet: ExcelJS.Worksheet; created: boolean } {
  if (name !== undefined) {
    const found = workbook.getWorksheet(name);
    if (found) return { sheet: found, created: false };
    if (!create) {
      const names = workbook.worksheets.map((ws) => ws.name).join(", ");
      throw new Error(`no sheet named ${JSON.stringify(name)} (sheets: ${names || "none"})`);
    }
    return { sheet: workbook.addWorksheet(name), created: true };
  }
  const first = workbook.worksheets[0];
  if (first) return { sheet: first, created: false };
  if (!create) throw new Error("the workbook has no sheets");
  return { sheet: workbook.addWorksheet("Sheet1"), created: true };
}

export function toCellValue(value: CellInput): ExcelJS.CellValue {
  if (value === null) return null;
  if (typeof value !== "string") return value;
  if (value.startsWith("'=")) return value.slice(1);
  if (value.startsWith("=") && value.length > 1) return { formula: value.slice(1) } as ExcelJS.CellFormulaValue;
  return value;
}

/** Write the block; returns the range it covered, like `A1:C4`. */
export function writeBlock(sheet: ExcelJS.Worksheet, block: WriteBlock): string {
  const origin = parseCellRef(block.cell);
  let width = 0;
  block.rows.forEach((row, r) => {
    width = Math.max(width, row.length);
    row.forEach((value, c) => {
      const cell = sheet.getCell(origin.row + r, origin.col + c);
      cell.value = toCellValue(value);
      if (block.bold === true) cell.font = { ...(cell.font ?? {}), bold: true };
      if (block.numFmt !== undefined) cell.numFmt = block.numFmt;
    });
  });
  const endRow = origin.row + Math.max(block.rows.length, 1) - 1;
  const endCol = origin.col + Math.max(width, 1) - 1;
  return `${columnLetters(origin.col)}${origin.row}:${columnLetters(endCol)}${endRow}`;
}

/** Render a range as `row | A | B` lines; formulas as `=F → value`. */
export function readRange(
  sheet: ExcelJS.Worksheet,
  range: string | undefined,
): { text: string; range: string; truncated: boolean } {
  let top: { row: number; col: number };
  let bottom: { row: number; col: number };
  if (range !== undefined) {
    const [a, b] = range.split(":");
    top = parseCellRef(a ?? "");
    bottom = b === undefined ? top : parseCellRef(b);
  } else {
    top = { row: 1, col: 1 };
    bottom = { row: Math.max(sheet.actualRowCount > 0 ? sheet.rowCount : 1, 1), col: Math.max(sheet.columnCount, 1) };
  }
  const r0 = Math.min(top.row, bottom.row);
  const c0 = Math.min(top.col, bottom.col);
  let r1 = Math.max(top.row, bottom.row);
  let c1 = Math.max(top.col, bottom.col);
  const truncated = r1 - r0 + 1 > READ_MAX_ROWS || c1 - c0 + 1 > READ_MAX_COLS;
  r1 = Math.min(r1, r0 + READ_MAX_ROWS - 1);
  c1 = Math.min(c1, c0 + READ_MAX_COLS - 1);
  const header = ["row"];
  for (let c = c0; c <= c1; c += 1) header.push(columnLetters(c));
  const lines = [header.join(" | ")];
  for (let r = r0; r <= r1; r += 1) {
    const cells = [String(r)];
    for (let c = c0; c <= c1; c += 1) cells.push(renderCell(sheet.getCell(r, c)));
    while (cells.length > 1 && cells[cells.length - 1] === "") cells.pop();
    if (cells.length > 1) lines.push(cells.join(" | "));
  }
  return {
    text: lines.join("\n"),
    range: `${columnLetters(c0)}${r0}:${columnLetters(c1)}${r1}`,
    truncated,
  };
}

function renderCell(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("formula" in value && typeof value.formula === "string") {
      const result = (value as { result?: unknown }).result;
      return result === undefined || result === null ? `=${value.formula}` : `=${value.formula} → ${plain(result)}`;
    }
    if ("sharedFormula" in value) {
      const result = (value as { result?: unknown }).result;
      return result === undefined ? `(shared formula)` : plain(result);
    }
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("");
    }
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("error" in value) return String(value.error);
  }
  return plain(value);
}

function plain(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value !== null && "error" in value) {
    return String((value as { error: unknown }).error);
  }
  return String(value).replace(/\r?\n/g, " ");
}
