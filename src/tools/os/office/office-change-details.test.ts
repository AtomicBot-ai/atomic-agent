import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsFsWritePptxTool } from "../pptx/write-pptx-tool.js";
import { buildOsFsDocxTool } from "./docx-tool.js";
import { buildOsFsXlsxTool } from "./xlsx-tool.js";

/**
 * ATO-2518: every Office write says in `details.change` whether the file
 * is new (`created`) or was already there (`updated`), next to its
 * absolute `details.path`. The HTTP stream sends both as `office_file`
 * for the desktop's "Changed files" row.
 */
const fixture = (name: string) =>
  resolve(fileURLToPath(new URL(`../test-fixtures/${name}`, import.meta.url)));

let dir: string;
let gate: ApprovalGate;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "office-change-"));
  gate = new ApprovalGate({
    level: 1,
    emit: (request) => {
      queueMicrotask(() => gate.resolve({ approvalId: request.approvalId, approved: true }));
    },
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({
  workingDir: dir,
  sessionId: "s-office-change",
  stepIndex: 0,
  signal: new AbortController().signal,
});
const options = () => ({ approvals: gate, approvalRequired: true });

describe("Office writers: details.change", () => {
  it("os.fs.docx: create is created, append and an overwrite are updated", async () => {
    const docx = buildOsFsDocxTool(options());
    const made = await docx.run({ path: "a.docx", op: "create", blocks: ["Hello"] }, ctx());
    expect(made.details).toMatchObject({ path: join(dir, "a.docx"), change: "created" });
    const appended = await docx.run({ path: "a.docx", op: "append", blocks: ["More"] }, ctx());
    expect(appended.details).toMatchObject({ path: join(dir, "a.docx"), change: "updated" });
    const replaced = await docx.run({ path: "a.docx", op: "create", blocks: ["New"], overwrite: true }, ctx());
    expect(replaced.details.change).toBe("updated");
  });

  it("os.fs.xlsx: create is created, write and chart on an existing workbook are updated, read has none", async () => {
    const xlsx = buildOsFsXlsxTool(options());
    const made = await xlsx.run({ path: "b.xlsx", op: "create", rows: [["Item", "Qty"], ["Pen", 2]] }, ctx());
    expect(made.details).toMatchObject({ path: join(dir, "b.xlsx"), change: "created" });
    const wrote = await xlsx.run({ path: "b.xlsx", op: "write", cell: "A3", rows: [["Pad", 3]] }, ctx());
    expect(wrote.details.change).toBe("updated");
    const charted = await xlsx.run({ path: "b.xlsx", op: "chart", range: "A1:B3" }, ctx());
    expect(charted.details.change).toBe("updated");
    await copyFile(fixture("sample.xlsx"), join(dir, "c.xlsx"));
    const read = await xlsx.run({ path: "c.xlsx", op: "read" }, ctx());
    expect(read.details).not.toHaveProperty("change");
  });

  it("os.fs.write_pptx: a new deck is created, a replaced one is updated", async () => {
    const pptx = buildOsFsWritePptxTool(options());
    const slides = [{ title: "Plan" }];
    const made = await pptx.run({ path: "d.pptx", slides }, ctx());
    expect(made.details).toMatchObject({ path: join(dir, "d.pptx"), change: "created" });
    const again = await pptx.run({ path: "d.pptx", slides, overwrite: true }, ctx());
    expect(again.details.change).toBe("updated");
  });
});
