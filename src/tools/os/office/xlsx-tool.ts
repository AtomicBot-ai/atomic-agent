import { extname } from "node:path";

import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { resolveUserPath } from "../expand-home.js";
import type { FsDangerousToolOptions } from "../fs/fs-require-approval.js";
import { OS_FS_XLSX_CONTRACT } from "./office-contracts.js";
import { commitOfficeFile, given, optionalString, readExisting } from "./office-write.js";
import {
  openWorkbook,
  parseCellRef,
  pickSheet,
  readRange,
  saveWorkbook,
  writeBlock,
  type CellInput,
} from "./xlsx-ops.js";

const TOOL = OS_FS_XLSX_CONTRACT.name;

/** One call's worth of cells. */
export const MAX_XLSX_CELLS = 50_000;

type XlsxOp = "create" | "write" | "read";

interface XlsxArgs {
  path: string;
  op: XlsxOp;
  sheet?: string;
  cell: string;
  rows: CellInput[][];
  range?: string;
  bold: boolean;
  numFmt?: string;
  overwrite: boolean;
}

function isCellInput(value: unknown): value is CellInput {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export function parseXlsxArgs(raw: Record<string, unknown>): XlsxArgs {
  const path = raw.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(`${TOOL}: \`path\` must be a non-empty string`);
  }
  const ext = extname(path).toLowerCase();
  if (ext !== ".xlsx") {
    const hint = ext === ".xls" ? "legacy .xls is not supported; save it as .xlsx first" : "for .docx use os.fs.docx";
    throw new Error(`${TOOL}: \`path\` must end in .xlsx (got ${JSON.stringify(path)}); ${hint}`);
  }
  const op = raw.op;
  if (op !== "create" && op !== "write" && op !== "read") {
    throw new Error(`${TOOL}: \`op\` must be one of create, write, read`);
  }
  let rows: CellInput[][] = [];
  if (given(raw.rows)) {
    if (
      !Array.isArray(raw.rows) ||
      !raw.rows.every((row) => Array.isArray(row) && row.every(isCellInput))
    ) {
      throw new Error(
        `${TOOL}: \`rows\` must be an array of rows, each an array of strings, numbers, booleans or null`,
      );
    }
    rows = raw.rows as CellInput[][];
  }
  const cells = rows.reduce((sum, row) => sum + row.length, 0);
  if (cells > MAX_XLSX_CELLS) {
    throw new Error(`${TOOL}: at most ${MAX_XLSX_CELLS} cells per call (got ${cells})`);
  }
  if (op === "write" && rows.length === 0) {
    throw new Error(`${TOOL}: write needs a non-empty \`rows\` array`);
  }
  const cell = optionalString(raw.cell, "cell", TOOL) ?? "A1";
  parseCellRef(cell);
  const range = optionalString(raw.range, "range", TOOL);
  if (range !== undefined) {
    for (const part of range.split(":")) parseCellRef(part);
  }
  const sheet = optionalString(raw.sheet, "sheet", TOOL);
  const numFmt = optionalString(raw.numFmt, "numFmt", TOOL);
  return {
    path,
    op,
    ...(sheet === undefined ? {} : { sheet }),
    cell,
    rows,
    ...(range === undefined ? {} : { range }),
    bold: raw.bold === true,
    ...(numFmt === undefined ? {} : { numFmt }),
    overwrite: raw.overwrite === true,
  };
}

export function buildOsFsXlsxTool(options: FsDangerousToolOptions): ToolDefinition {
  return {
    name: TOOL,
    description: OS_FS_XLSX_CONTRACT.description,
    readonly: OS_FS_XLSX_CONTRACT.readonly,
    async run(rawArgs, ctx) {
      const args = parseXlsxArgs(rawArgs);
      const absolute = resolveUserPath(args.path, ctx.workingDir);
      const existing = await readExisting(absolute, TOOL);

      if (args.op === "read") {
        if (existing === null) throw new Error(`${TOOL}: ${absolute} does not exist`);
        const workbook = await wrapXlsxError(() => openWorkbook(existing), absolute);
        const { sheet } = pickSheet(workbook, args.sheet, false);
        const shown = readRange(sheet, args.range);
        const names = workbook.worksheets.map((ws) => ws.name);
        const head = `## Sheet: ${sheet.name} (${shown.range}); sheets: ${names.join(", ")}`;
        const note = shown.truncated ? "\n(range cut to the first 200 rows and 50 columns; pass a smaller `range` for more)" : "";
        return compressToolResult(
          {
            tool: TOOL,
            status: "ok",
            output: `${head}\n${shown.text}${note}`,
            details: { path: absolute, op: "read", sheet: sheet.name, range: shown.range, sheets: names, truncated: shown.truncated },
          },
          { maxSummaryLength: 32_000, maxTailLines: 400 },
        );
      }

      if (args.op === "create" && existing !== null && !args.overwrite) {
        throw new Error(
          `${TOOL}: ${absolute} already exists; use op write to change it, or overwrite: true to replace it`,
        );
      }
      if (args.op === "write" && existing === null) {
        throw new Error(`${TOOL}: ${absolute} does not exist; use op create to make it`);
      }
      // Built again from the bytes on disk after the approval answer when
      // the file changed while the card was open, so a save made
      // meanwhile (in Excel, by another tool) is kept, not overwritten.
      const build = async (current: Buffer | null): Promise<XlsxEdit> => {
        if (args.op === "write" && current === null) {
          throw new Error(`${TOOL}: ${absolute} does not exist; use op create to make it`);
        }
        const workbook = await wrapXlsxError(
          () => openWorkbook(args.op === "write" && current !== null ? current : undefined),
          absolute,
        );
        const { sheet, created } = pickSheet(workbook, args.sheet, true);
        const written =
          args.rows.length === 0
            ? null
            : writeBlock(sheet, {
                cell: args.cell,
                rows: args.rows,
                bold: args.bold,
                ...(args.numFmt === undefined ? {} : { numFmt: args.numFmt }),
              });
        return { data: await saveWorkbook(workbook), sheetName: sheet.name, created, written };
      };
      let edit = await build(existing);
      const formulas = args.rows.flat().filter((v) => typeof v === "string" && v.startsWith("=") && v.length > 1).length;
      const whereOf = (e: XlsxEdit) => (e.written === null ? `sheet ${e.sheetName}` : `${e.sheetName}!${e.written}`);
      const result = await commitOfficeFile(options, ctx, {
        tool: TOOL,
        absolute,
        display: args.path,
        data: edit.data,
        baseline: existing,
        rebuild: async (fresh) => {
          if (args.op === "create" && existing === null && fresh !== null) {
            // The card offered a new file; replacing one is a different question.
            throw new Error(`${TOOL}: ${absolute} appeared meanwhile; ask again to replace it`);
          }
          edit = await build(fresh);
          return edit.data;
        },
        reason: `${args.op === "create" ? (existing === null ? "create" : "replace") : "write"} spreadsheet ${absolute} (${whereOf(edit)})`,
        preview: args.rows.slice(0, 10).map((row) => row.map((v) => (v === null ? "" : String(v))).join(" | ")).join("\n"),
        replacesWhole: args.op === "create" && existing !== null,
      });
      const { sheetName, created, written } = edit;
      const data = result.data;
      const where = whereOf(edit);
      const verb = args.op === "create" ? (existing === null ? "created" : "replaced") : "wrote";
      const done = `${verb} ${absolute} (${where}${formulas > 0 ? `, ${formulas} formula${formulas === 1 ? "" : "s"}` : ""}${created && args.op === "write" ? `, new sheet ${sheetName}` : ""})`;
      const output = result.restoreNote === null ? done : `${done}; ${result.restoreNote}`;
      return compressToolResult({
        tool: TOOL,
        status: "ok",
        output,
        details: {
          path: absolute,
          op: args.op,
          sheet: sheetName,
          ...(written === null ? {} : { range: written }),
          formulas,
          sheetCreated: created,
          bytes: data.byteLength,
          ...(result.rebuilt ? { rebuiltAfterApproval: true } : {}),
        },
      });
    },
  };
}

interface XlsxEdit {
  data: Buffer;
  sheetName: string;
  created: boolean;
  written: string | null;
}

async function wrapXlsxError<T>(work: () => Promise<T>, absolute: string): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw new Error(`${TOOL}: could not open ${absolute} as a workbook: ${(err as Error).message}`);
  }
}
