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
    "Create or edit a Word .docx file directly, with no Python, pandoc or office app needed. op create: a new document from blocks; append: add blocks at the end; replace: change every occurrence of `find` to `replaceWith` (all: false for the first only), keeping the formatting, in the body, headers and footers. Each block is a paragraph: '# ', '## ', '### ' make headings, '- ' a bullet, **bold** inline. An existing file is replaced by create only with overwrite: true; a changed file's previous version is saved for os.fs.restore. To read a .docx use os.fs.read_document. May require approval.",
  readonly: false,
  resourceClass: "approval_gated",
  descriptor: {
    name: DOCX,
    summary:
      "Create a Word .docx, append paragraphs/headings to one, or find-and-replace text in it, without external tools (may require approval). Blocks: '# Heading', '- bullet', **bold**. Read a .docx with os.fs.read_document.",
    argsSchema:
      "{ path: string, op: 'create' | 'append' | 'replace', blocks?: string[], find?: string, replaceWith?: string, all?: boolean, overwrite?: boolean }",
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
      overwrite: { type: "boolean" },
    },
    required: ["path", "op"],
    additionalProperties: false,
  },
} as const;

export const OS_FS_XLSX_CONTRACT = {
  name: XLSX,
  description:
    "Create, write or read an Excel .xlsx workbook directly, with no Python or office app needed. op create: a new workbook (optional first block of rows); write: put rows into a sheet starting at `cell` (default A1), making the sheet if it is missing; read: show a range (default the used area) with formulas. In rows a string starting with = is a formula ('=SUM(B2:B9)'), '= keeps a literal =, null clears a cell; bold and numFmt (like '0.00' or 'yyyy-mm-dd') style the written cells. Saved workbooks recalculate when opened. An existing file is replaced by create only with overwrite: true; a changed file's previous version is saved for os.fs.restore. May require approval (read does not).",
  readonly: false,
  resourceClass: "approval_gated",
  descriptor: {
    name: XLSX,
    summary:
      "Create an Excel .xlsx, write cells and formulas into it, or read a range with its formulas, without external tools (writes may require approval).",
    argsSchema:
      "{ path: string, op: 'create' | 'write' | 'read', sheet?: string, cell?: string, rows?: (string | number | boolean | null)[][], range?: string, bold?: boolean, numFmt?: string, overwrite?: boolean } /* '=SUM(B2:B9)' is a formula; range like 'A1:D20' */",
    tier: "rare",
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      op: { type: "string", enum: ["create", "write", "read"] },
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
      bold: { type: "boolean" },
      numFmt: { type: "string" },
      overwrite: { type: "boolean" },
    },
    required: ["path", "op"],
    additionalProperties: false,
  },
} as const;
