import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalGate, type ApprovalRequest } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { FileRestoreStore } from "../fs/fs-restore-store.js";
import { xlsxExtractor } from "../read-document/extractors/xlsx-extractor.js";
import { buildOsFsXlsxTool, parseXlsxArgs } from "./xlsx-tool.js";
import { columnLetters, openWorkbook, parseCellRef, saveWorkbook, toCellValue } from "./xlsx-ops.js";

const FIXTURE = resolve(
  fileURLToPath(new URL("../test-fixtures/sample.xlsx", import.meta.url)),
);

let dir: string;
let state: string;
let gate: ApprovalGate;
let prompts: ApprovalRequest[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "office-xlsx-"));
  state = await mkdtemp(join(tmpdir(), "office-xlsx-state-"));
  prompts = [];
  gate = new ApprovalGate({
    level: 1,
    emit: (request) => {
      prompts.push(request);
      queueMicrotask(() => gate.resolve({ approvalId: request.approvalId, approved: true }));
    },
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({
  workingDir: dir,
  sessionId: "s-xlsx",
  stepIndex: 0,
  signal: new AbortController().signal,
});

function tool(restore?: FileRestoreStore) {
  return buildOsFsXlsxTool({ approvals: gate, approvalRequired: true, ...(restore ? { restore } : {}) });
}

async function textOf(path: string, sheets?: string[]): Promise<string> {
  const data = await readFile(path);
  return (await xlsxExtractor({ data, sourcePath: path, ...(sheets ? { sheets } : {}) })).text;
}

describe("os.fs.xlsx", () => {
  it("creates a workbook with values and formulas that the reader sees", async () => {
    const result = await tool().run(
      {
        path: "budget.xlsx",
        op: "create",
        sheet: "Budget",
        rows: [
          ["Item", "Qty", "Price", "Total"],
          ["Pen", 2, 1.5, "=B2*C2"],
          ["Pad", 3, 4, "=B3*C3"],
          ["Sum", null, null, "=SUM(D2:D3)"],
        ],
        bold: false,
      },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(result.details).toMatchObject({ sheet: "Budget", range: "A1:D4", formulas: 3 });
    expect(prompts).toHaveLength(1);
    const text = await textOf(join(dir, "budget.xlsx"));
    expect(text).toContain("## Sheet: Budget");
    expect(text).toContain("Item | Qty | Price | Total");
    // No cached result in a freshly written file: the reader shows the formula.
    expect(text).toContain("Pen | 2 | 1.5 | =B2*C2");
    expect(text).toContain("=SUM(D2:D3)");
    // Asks Excel / LibreOffice to compute the formulas on open.
    const zip = await JSZip.loadAsync(await readFile(join(dir, "budget.xlsx")));
    expect(await zip.file("xl/workbook.xml")!.async("text")).toMatch(/fullCalcOnLoad="1"/);
  });

  it("writes into an existing workbook, adds a missing sheet and styles the cells", async () => {
    await copyFile(FIXTURE, join(dir, "data.xlsx"));
    const restore = new FileRestoreStore(state);
    const result = await tool(restore).run(
      { path: "data.xlsx", op: "write", sheet: "Summary", cell: "B2", rows: [["Total", "=SUM(Revenue!B2:B3)"]], bold: true, numFmt: "0.00" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(result.details).toMatchObject({ sheetCreated: true, range: "B2:C2" });
    expect(result.summary).toContain("os.fs.restore");
    const text = await textOf(join(dir, "data.xlsx"));
    expect(text).toContain("Q1 | 1200 | Good");
    expect(text).toContain("## Sheet: Summary");
    expect(text).toContain("Total | =SUM(Revenue!B2:B3)");
    const workbook = await openWorkbook(await readFile(join(dir, "data.xlsx")));
    const cell = workbook.getWorksheet("Summary")!.getCell("C2");
    expect(cell.font?.bold).toBe(true);
    expect(cell.numFmt).toBe("0.00");
  });

  it("overwrites cells in place and clears one with null", async () => {
    await copyFile(FIXTURE, join(dir, "data.xlsx"));
    await tool().run({ path: "data.xlsx", op: "write", sheet: "Revenue", cell: "C2", rows: [["Great"], [null]] }, ctx());
    const text = await textOf(join(dir, "data.xlsx"), ["Revenue"]);
    expect(text).toContain("Q1 | 1200 | Great");
    expect(text).not.toContain("Better");
  });

  it("reads a range with formulas and asks nothing", async () => {
    await tool().run({ path: "t.xlsx", op: "create", rows: [["a", 1], ["b", "=B1+1"]] }, ctx());
    prompts = [];
    const result = await tool().run({ path: "t.xlsx", op: "read" }, ctx());
    expect(prompts).toHaveLength(0);
    expect(result.summary).toContain("## Sheet: Sheet1 (A1:B2)");
    expect(result.summary).toContain("row | A | B");
    expect(result.summary).toContain("2 | b | =B1+1");
    const narrow = await tool().run({ path: "t.xlsx", op: "read", range: "B2" }, ctx());
    expect(narrow.details.range).toBe("B2:B2");
    await expect(tool().run({ path: "t.xlsx", op: "read", sheet: "Nope" }, ctx())).rejects.toThrow(/no sheet named/);
  });

  it("redoes the write on a save made while the approval card was open", async () => {
    const path = join(dir, "data.xlsx");
    await copyFile(FIXTURE, path);
    // The user types into the sheet in Excel and saves before answering.
    const original = gate.request.bind(gate);
    gate.request = (async (...a: Parameters<ApprovalGate["request"]>) => {
      const decision = await original(...a);
      const workbook = await openWorkbook(await readFile(path));
      workbook.worksheets[0]!.getCell("Z50").value = "saved in Excel meanwhile";
      await writeFile(path, await saveWorkbook(workbook));
      return decision;
    }) as ApprovalGate["request"];
    const result = await tool().run({ path: "data.xlsx", op: "write", cell: "Y1", rows: [["from the agent"]] }, ctx());
    expect(result.status).toBe("ok");
    expect(result.details.rebuiltAfterApproval).toBe(true);
    const sheet = (await openWorkbook(await readFile(path))).worksheets[0]!;
    expect(sheet.getCell("Z50").value).toBe("saved in Excel meanwhile");
    expect(sheet.getCell("Y1").value).toBe("from the agent");
  });

  it("refuses create over an existing file without overwrite, and write to a missing file", async () => {
    await copyFile(FIXTURE, join(dir, "data.xlsx"));
    await expect(tool().run({ path: "data.xlsx", op: "create" }, ctx())).rejects.toThrow(/already exists/);
    await expect(tool().run({ path: "none.xlsx", op: "write", rows: [[1]] }, ctx())).rejects.toThrow(/does not exist/);
    expect(prompts).toHaveLength(0);
  });
});

describe("xlsx helpers", () => {
  it("parses cell references and spells column letters", () => {
    expect(parseCellRef("A1")).toEqual({ row: 1, col: 1 });
    expect(parseCellRef("$AB$12")).toEqual({ row: 12, col: 28 });
    expect(() => parseCellRef("1A")).toThrow(/not a cell reference/);
    expect(columnLetters(1)).toBe("A");
    expect(columnLetters(27)).toBe("AA");
    expect(columnLetters(16384)).toBe("XFD");
  });

  it("turns =text into a formula, '= into a literal, and keeps other values", () => {
    expect(toCellValue("=SUM(A1:A2)")).toEqual({ formula: "SUM(A1:A2)" });
    expect(toCellValue("'=not a formula")).toBe("=not a formula");
    expect(toCellValue("=")).toBe("=");
    expect(toCellValue(3)).toBe(3);
    expect(toCellValue(null)).toBeNull();
  });

  it("validates arguments and treats strict-provider fillers as absent", () => {
    expect(() => parseXlsxArgs({ path: "a.xls", op: "read" })).toThrow(/legacy \.xls/);
    expect(() => parseXlsxArgs({ path: "a.xlsx", op: "write", rows: [] })).toThrow(/rows/);
    expect(() => parseXlsxArgs({ path: "a.xlsx", op: "write", rows: [[{}]] })).toThrow(/rows/);
    expect(() => parseXlsxArgs({ path: "a.xlsx", op: "read", range: "A1:ZZZZ9" })).toThrow(/cell reference/);
    expect(parseXlsxArgs({ path: "a.xlsx", op: "read", cell: "", sheet: null, range: null, numFmt: "" })).toMatchObject({
      cell: "A1",
      rows: [],
    });
  });
});
