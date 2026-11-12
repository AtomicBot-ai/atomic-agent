import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalGate,
  type ApprovalDecision,
  type ApprovalRequest,
} from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { FileRestoreStore } from "../fs/fs-restore-store.js";
import { docxExtractor } from "../read-document/extractors/docx-extractor.js";
import { buildOsFsDocxTool, parseDocxArgs } from "./docx-tool.js";

const FIXTURE = resolve(
  fileURLToPath(new URL("../test-fixtures/sample.docx", import.meta.url)),
);

let dir: string;
let state: string;
let gate: ApprovalGate;
let prompts: ApprovalRequest[];
let answers: Omit<ApprovalDecision, "approvalId">[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "office-docx-"));
  state = await mkdtemp(join(tmpdir(), "office-docx-state-"));
  prompts = [];
  answers = [];
  gate = new ApprovalGate({
    level: 1,
    emit: (request) => {
      prompts.push(request);
      const answer = answers.shift() ?? { approved: true };
      queueMicrotask(() => gate.resolve({ approvalId: request.approvalId, ...answer }));
    },
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({
  workingDir: dir,
  sessionId: "s-docx",
  stepIndex: 0,
  signal: new AbortController().signal,
});

function tool(restore?: FileRestoreStore) {
  return buildOsFsDocxTool({
    approvals: gate,
    approvalRequired: true,
    ...(restore ? { restore } : {}),
  });
}

async function textOf(path: string): Promise<string> {
  const data = await readFile(path);
  return (await docxExtractor({ data, sourcePath: path })).text;
}

describe("os.fs.docx", () => {
  it("creates a document that reads back with headings, bullets and bold", async () => {
    const result = await tool().run(
      {
        path: "report.docx",
        op: "create",
        blocks: ["# Quarterly report", "## Summary", "Revenue grew **12%**.", "- North\n- South"],
      },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(result.details.paragraphs).toBe(5);
    expect(prompts).toHaveLength(1);
    const text = await textOf(join(dir, "report.docx"));
    expect(text).toMatch(/^# Quarterly report/m);
    expect(text).toMatch(/^## Summary/m);
    expect(text).toContain("12%");
    expect(text).toContain("• North");
    const zip = await JSZip.loadAsync(await readFile(join(dir, "report.docx")));
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml"]),
    );
  });

  it("refuses to create over an existing file unless overwrite is set, before asking", async () => {
    await copyFile(FIXTURE, join(dir, "a.docx"));
    await expect(tool().run({ path: "a.docx", op: "create", blocks: ["x"] }, ctx())).rejects.toThrow(
      /already exists/,
    );
    expect(prompts).toHaveLength(0);
    const ok = await tool().run({ path: "a.docx", op: "create", blocks: ["fresh"], overwrite: true }, ctx());
    expect(ok.status).toBe("ok");
    expect(await textOf(join(dir, "a.docx"))).toBe("fresh");
  });

  it("appends to an existing Word file and keeps what was there", async () => {
    await copyFile(FIXTURE, join(dir, "doc.docx"));
    const result = await tool().run(
      { path: "doc.docx", op: "append", blocks: ["## Next steps", "Ship it."] },
      ctx(),
    );
    expect(result.status).toBe("ok");
    const text = await textOf(join(dir, "doc.docx"));
    expect(text).toMatch(/^# Document Title/m);
    expect(text).toContain("all systems nominal");
    expect(text).toMatch(/^## Next steps/m);
    expect(text.indexOf("Ship it.")).toBeGreaterThan(text.indexOf("all systems nominal"));
    // Still a valid document: the page setup stays the last thing in the body.
    const zip = await JSZip.loadAsync(await readFile(join(dir, "doc.docx")));
    const xml = await zip.file("word/document.xml")!.async("text");
    expect(xml.indexOf("Ship it.")).toBeLessThan(xml.lastIndexOf("<w:sectPr"));
  });

  it("replaces text, saves the previous version and can say nothing matched", async () => {
    await copyFile(FIXTURE, join(dir, "doc.docx"));
    const restore = new FileRestoreStore(state);
    const result = await tool(restore).run(
      { path: "doc.docx", op: "replace", find: "all systems nominal", replaceWith: "everything works" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(result.details.replacements).toBe(1);
    expect(result.summary).toContain("os.fs.restore");
    const text = await textOf(join(dir, "doc.docx"));
    expect(text).toContain("Second paragraph: everything works.");
    expect(text).not.toContain("nominal");

    await expect(
      tool(restore).run({ path: "doc.docx", op: "replace", find: "no such words" }, ctx()),
    ).rejects.toThrow(/was not found/);
  });

  it("writes nothing when the operator declines", async () => {
    await copyFile(FIXTURE, join(dir, "doc.docx"));
    const before = await readFile(join(dir, "doc.docx"));
    answers.push({ approved: false });
    await expect(
      tool().run({ path: "doc.docx", op: "append", blocks: ["nope"] }, ctx()),
    ).rejects.toThrow();
    expect((await readFile(join(dir, "doc.docx"))).equals(before)).toBe(true);
  });

  it("reports a file that is not a Word document", async () => {
    await writeFile(join(dir, "fake.docx"), "plain text");
    await expect(
      tool().run({ path: "fake.docx", op: "append", blocks: ["x"] }, ctx()),
    ).rejects.toThrow(/could not edit/);
    expect(prompts).toHaveLength(0);
  });
});

describe("parseDocxArgs", () => {
  it("rejects a non-.docx path, an unknown op and a replace without find", () => {
    expect(() => parseDocxArgs({ path: "a.xlsx", op: "create" })).toThrow(/os\.fs\.xlsx/);
    expect(() => parseDocxArgs({ path: "a.docx", op: "edit" })).toThrow(/op/);
    expect(() => parseDocxArgs({ path: "a.docx", op: "replace", find: "" })).toThrow(/find/);
    expect(() => parseDocxArgs({ path: "a.docx", op: "append", blocks: [] })).toThrow(/blocks/);
  });

  it("reads strict-provider fillers (null, empty string) as absent", () => {
    const args = parseDocxArgs({
      path: "a.docx",
      op: "replace",
      find: "x",
      replaceWith: null,
      blocks: null,
      all: null,
      overwrite: null,
    });
    expect(args).toMatchObject({ blocks: [], replaceWith: "", all: true, overwrite: false });
  });
});
