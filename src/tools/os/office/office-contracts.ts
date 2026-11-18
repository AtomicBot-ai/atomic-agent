/**
 * The catalog facts of `os.fs.docx` and `os.fs.xlsx`, one owner each:
 * registration, prompt descriptor, wire schema and resource class read
 * them from here so they cannot drift apart.
 */

const DOCX = "os.fs.docx";
const XLSX = "os.fs.xlsx";

export const OS_FS_DOCX_CONTRACT = {
  name: DOCX,
  description:
    "Create or edit a Word .docx file directly, with no Python, pandoc or office app needed. op create: a new document from blocks; append: add blocks at the end; replace: change every occurrence of `find` to `replaceWith` (all: false for the first only), keeping the formatting, in the body, headers and footers. Each block is a paragraph: '# ', '## ', '### ' make headings, '- ' a bullet and '1. ' a numbered item (two leading spaces per level), '![alt](picture.png)' a png/jpg/gif picture, **bold** inline; a block of '| a | b |' lines is a table (first row the header). track: true writes append or replace as Word tracked changes by Atomic Agent, for the author to accept or reject. An existing file is replaced by create only with overwrite: true; a changed file's previous version is saved for os.fs.restore. To read a .docx use os.fs.read_document. May require approval.",
  readonly: false,
  resourceClass: "approval_gated",
  descriptor: {
    name: DOCX,
    summary:
      "Create a Word .docx, append paragraphs/headings/lists/tables/pictures to one, or find-and-replace text in it, optionally as tracked changes, without external tools (may require approval). Blocks: '# Heading', '- bullet', '1. item', '| a | b |' table lines, '![alt](pic.png)', **bold**. Read a .docx with os.fs.read_document.",
    argsSchema:
      "{ path: string, op: 'create' | 'append' | 'replace', blocks?: string[], find?: string, replaceWith?: string, all?: boolean, track?: boolean /* tracked changes, append/replace */, overwrite?: boolean }",
    tier: "rare",
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      op: { type: "string", enum: ["create", "append", "replace"] },
      blocks: { type: "array", items: { type: "string" } },
      find: { type: "string" },
      replaceWith: { type: "string" },
      all: { type: "boolean" },
      track: { type: "boolean" },
      overwrite: { type: "boolean" },
    },
    required: ["path", "op"],
    additionalProperties: false,
  },
} as const;

export const OS_FS_XLSX_CONTRACT = {
  name: XLSX,
  description:
    "Create, write or read an Excel .xlsx workbook directly, with no Python or office app needed. op create: a new workbook (optional first block of rows); write: put rows into a sheet starting at `cell` (default A1), making the sheet if it is missing; read: show a range (default the used area) with formulas; chart: add a native Excel chart (chartType column, bar, line or pie; optional title) over `range`, whose first row holds the series names and first column the categories, placed at `cell` (default beside the data). In rows a string starting with = is a formula ('=SUM(B2:B9)'), '= keeps a literal =, null clears a cell; bold and numFmt (like '0.00' or 'yyyy-mm-dd') style the written cells. Saved workbooks recalculate when opened. An existing file is replaced by create only with overwrite: true; a changed file's previous version is saved for os.fs.restore. May require approval (read does not).",
  readonly: false,
  resourceClass: "approval_gated",
  descriptor: {
    name: XLSX,
    summary:
      "Create an Excel .xlsx, write cells and formulas into it, read a range with its formulas, or add a column/bar/line/pie chart over a range, without external tools (writes may require approval).",
    argsSchema:
      "{ path: string, op: 'create' | 'write' | 'read' | 'chart', sheet?: string, cell?: string, rows?: (string | number | boolean | null)[][], range?: string, chartType?: 'column' | 'bar' | 'line' | 'pie', title?: string, bold?: boolean, numFmt?: string, overwrite?: boolean } /* '=SUM(B2:B9)' is a formula; range like 'A1:D20'; chart: header row = series names, first column = categories */",
    tier: "rare",
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      op: { type: "string", enum: ["create", "write", "read", "chart"] },
      sheet: { type: "string" },
      cell: { type: "string" },
      rows: {
        type: "array",
        items: {
          type: "array",
          items: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "null" },
            ],
          },
        },
      },
      range: { type: "string" },
      chartType: { type: "string", enum: ["column", "bar", "line", "pie"] },
      title: { type: "string" },
      bold: { type: "boolean" },
      numFmt: { type: "string" },
      overwrite: { type: "boolean" },
    },
    required: ["path", "op"],
    additionalProperties: false,
  },
} as const;
