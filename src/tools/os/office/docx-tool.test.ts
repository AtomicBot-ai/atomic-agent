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
import { appendToDocx } from "./docx-package.js";
import { buildOsFsDocxTool, parseDocxArgs } from "./docx-tool.js";
import { parseBlocks } from "./docx-xml.js";

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
  // mammoth's Markdown escapes punctuation in body text (`Ship it\.`);
  // the checks below are about the words, so read them back plain.
  return (await docxExtractor({ data, sourcePath: path })).text.replace(
    /\\([\\`*_{}[\]()#+\-.!])/g,
    "$1",
  );
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
    // A real Word list now: mammoth reads it back as a Markdown list.
    expect(text).toMatch(/^- North/m);
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

  it("redoes the edit on a save made while the approval card was open", async () => {
    const path = join(dir, "doc.docx");
    await copyFile(FIXTURE, path);
    // The user saves the document in Word (one more paragraph) before answering.
    const original = gate.request.bind(gate);
    gate.request = (async (...a: Parameters<ApprovalGate["request"]>) => {
      const decision = await original(...a);
      await writeFile(path, await appendToDocx(await readFile(path), parseBlocks(["Saved in Word meanwhile."])));
      return decision;
    }) as ApprovalGate["request"];
    const result = await tool().run({ path: "doc.docx", op: "append", blocks: ["Ship it."] }, ctx());
    expect(result.status).toBe("ok");
    expect(result.details.rebuiltAfterApproval).toBe(true);
    const text = await textOf(path);
    expect(text).toContain("all systems nominal");
    expect(text).toContain("Saved in Word meanwhile.");
    expect(text.indexOf("Ship it.")).toBeGreaterThan(text.indexOf("Saved in Word meanwhile."));
  });

  it("refuses, writing nothing, when the file changed under the card and the edit cannot be redone", async () => {
    const path = join(dir, "doc.docx");
    await copyFile(FIXTURE, path);
    const original = gate.request.bind(gate);
    gate.request = (async (...a: Parameters<ApprovalGate["request"]>) => {
      const decision = await original(...a);
      await writeFile(path, "no longer a zip");
      return decision;
    }) as ApprovalGate["request"];
    await expect(
      tool().run({ path: "doc.docx", op: "append", blocks: ["Ship it."] }, ctx()),
    ).rejects.toThrow(/changed while the approval prompt was open/);
    expect(await readFile(path, "utf8")).toBe("no longer a zip");
  });

  it("reports a file that is not a Word document", async () => {
    await writeFile(join(dir, "fake.docx"), "plain text");
    await expect(
      tool().run({ path: "fake.docx", op: "append", blocks: ["x"] }, ctx()),
    ).rejects.toThrow(/could not edit/);
    expect(prompts).toHaveLength(0);
  });
});

describe("os.fs.docx tracked changes and pictures (ATO-541)", () => {
  /** A real 1×1 PNG. */
  const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );

  it("writes a replace as tracked changes by Atomic Agent when track is set", async () => {
    await copyFile(FIXTURE, join(dir, "doc.docx"));
    const result = await tool().run(
      { path: "doc.docx", op: "replace", find: "all systems nominal", replaceWith: "everything works", track: true },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(result.details).toMatchObject({ replacements: 1, tracked: true });
    expect(result.summary).toContain("tracked changes by Atomic Agent");
    const zip = await JSZip.loadAsync(await readFile(join(dir, "doc.docx")));
    const xml = await zip.file("word/document.xml")!.async("text");
    expect(xml).toMatch(/<w:del w:id="\d+" w:author="Atomic Agent" w:date="[^"]+Z">/);
    // Word may have split the sentence over runs: the deleted pieces read back in order.
    const deleted = [...xml.matchAll(/<w:delText[^>]*>([^<]*)<\/w:delText>/g)].map((m) => m[1]).join("");
    expect(deleted).toBe("all systems nominal");
    expect(xml).toMatch(/<w:ins w:id="\d+" w:author="Atomic Agent" [^>]*><w:r\b[^>]*>(<w:rPr>.*?<\/w:rPr>)?<w:t xml:space="preserve">everything works<\/w:t>/);
  });

  it("refuses track on create, before asking", async () => {
    await expect(tool().run({ path: "n.docx", op: "create", blocks: ["x"], track: true }, ctx())).rejects.toThrow(
      /track applies to append and replace/,
    );
    expect(prompts).toHaveLength(0);
  });

  it("embeds a picture from disk and refuses a missing or non-picture file before asking", async () => {
    await writeFile(join(dir, "dot.png"), PNG_1X1);
    const ok = await tool().run({ path: "pic.docx", op: "create", blocks: ["# Logo", "![The dot](dot.png)"] }, ctx());
    expect(ok.status).toBe("ok");
    const zip = await JSZip.loadAsync(await readFile(join(dir, "pic.docx")));
    expect(zip.file("word/media/image1.png")).not.toBeNull();
    expect(await zip.file("word/document.xml")!.async("text")).toContain('descr="The dot"');

    await expect(tool().run({ path: "b.docx", op: "create", blocks: ["![x](missing.png)"] }, ctx())).rejects.toThrow(
      /no picture at missing\.png/,
    );
    await writeFile(join(dir, "notes.png"), "not really a png");
    await expect(tool().run({ path: "b.docx", op: "create", blocks: ["![x](notes.png)"] }, ctx())).rejects.toThrow(
      /not a PNG, JPEG or GIF/,
    );
    expect(prompts).toHaveLength(1);
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
