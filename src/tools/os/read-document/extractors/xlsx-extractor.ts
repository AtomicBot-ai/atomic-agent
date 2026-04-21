import type { Extractor } from "./extractor-types.js";

/**
 * XLSX extractor backed by exceljs. Produces a compact pipe-separated
 * rendering per sheet:
 *
 *     ## Sheet: Revenue
 *     Quarter | Amount | Notes
 *     Q1 | 1200 | Good
 *     Q2 | 1500 | Better
 *
 * - Trailing empty cells are stripped so "Q1 | 1200 |  |  | " becomes "Q1 | 1200".
 * - Fully empty rows are skipped (common padding in exported spreadsheets).
 * - Formula cells render as their cached calculated value (Excel keeps one
 *   in the file), falling back to the raw formula string if none is cached.
 * - Dates are serialised as ISO strings so the LLM can parse them.
 *
 * Legacy .xls (BIFF) is NOT supported by exceljs; the dispatcher only
 * routes `.xlsx` here. For .xls the user should convert via Excel /
 * LibreOffice first.
 */
export const xlsxExtractor: Extractor = async (input) => {
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(toArrayBuffer(input.data));

  const warnings: string[] = [];
  const allSheets = workbook.worksheets;
  const selection = selectSheets(allSheets, input.sheets, warnings);
  const showHeader = input.pageSeparators !== false;

  const parts: string[] = [];
  for (const ws of selection) {
    if (showHeader) parts.push(`## Sheet: ${ws.name}`);
    const rowsText = renderSheet(ws);
    if (rowsText.length > 0) parts.push(rowsText);
  }

  return {
    format: "xlsx",
    text: parts.join("\n\n").trim(),
    sheetCount: allSheets.length,
    pagesExtracted: selection.map((s) => allSheets.indexOf(s) + 1),
    warnings,
  };
};

interface WorksheetLike {
  name: string;
  id: number;
  eachRow(
    options: { includeEmpty: boolean },
    cb: (row: { eachCell: (opts: { includeEmpty: boolean }, cb: (cell: CellLike, col: number) => void) => void }, rowNumber: number) => void,
  ): void;
}

interface CellLike {
  value: unknown;
  result?: unknown;
  formula?: string;
  type?: number;
}

function selectSheets(
  all: WorksheetLike[],
  requested: readonly (string | number)[] | undefined,
  warnings: string[],
): WorksheetLike[] {
  if (!requested || requested.length === 0) return all;
  const picked: WorksheetLike[] = [];
  for (const entry of requested) {
    if (typeof entry === "number") {
      const ws = all[entry - 1];
      if (ws) picked.push(ws);
      else warnings.push(`sheet index ${entry} is out of range`);
    } else {
      const ws = all.find((s) => s.name === entry);
      if (ws) picked.push(ws);
      else warnings.push(`sheet ${JSON.stringify(entry)} not found`);
    }
  }
  return picked;
}

function renderSheet(ws: WorksheetLike): string {
  const rows: string[] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      cells.push(renderCell(cell));
    });
    while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    if (cells.length === 0) return;
    rows.push(cells.join(" | "));
  });
  return rows.join("\n");
}

function renderCell(cell: CellLike): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    // exceljs boxes formulas / rich text / hyperlinks / errors into objects.
    const asFormula = value as { result?: unknown; formula?: string };
    if ("result" in asFormula && asFormula.result !== undefined) {
      return renderCell({ value: asFormula.result });
    }
    if ("formula" in asFormula && typeof asFormula.formula === "string") {
      return `=${asFormula.formula}`;
    }
    const asRichText = value as { richText?: Array<{ text?: string }> };
    if (Array.isArray(asRichText.richText)) {
      return asRichText.richText.map((r) => r.text ?? "").join("");
    }
    const asHyperlink = value as { text?: string; hyperlink?: string };
    if (typeof asHyperlink.text === "string") return asHyperlink.text;
  }
  return String(value);
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  // Node Buffers are views over shared memory; slice off a standalone
  // ArrayBuffer so exceljs's zip reader can own it safely.
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return copy.buffer;
}

type ExcelJsModule = { Workbook: new () => { xlsx: { load(data: ArrayBuffer): Promise<unknown> }; worksheets: WorksheetLike[] } };

let excelJsModule: ExcelJsModule | undefined;
async function loadExcelJs(): Promise<ExcelJsModule> {
  if (!excelJsModule) {
    const mod = (await import("exceljs")) as
      | ExcelJsModule
      | { default: ExcelJsModule };
    excelJsModule = "default" in mod ? mod.default : mod;
  }
  return excelJsModule;
}
