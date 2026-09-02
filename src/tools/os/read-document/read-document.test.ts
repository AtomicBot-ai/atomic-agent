import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { buildOsFsReadDocumentTool } from "./read-document.js";
import type {
  Extractor,
  ExtractorInput,
  ExtractResult,
} from "./extractors/extractor-types.js";
import type { ToolContext } from "../tool-registry.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

async function makeTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `atomic-agent-read-doc-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

function fakeExtractor(
  override: Partial<ExtractResult>,
  onInput?: (input: ExtractorInput) => void,
): Extractor {
  return async (input) => {
    onInput?.(input);
    return {
      format: "plain",
      text: "stub",
      warnings: [],
      ...override,
    };
  };
}

describe("os.fs.read_document dispatcher", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });

  it("dispatches to the extractor matching the file extension", async () => {
    const seen: string[] = [];
    const tool = buildOsFsReadDocumentTool({
      extractors: {
        pdf: fakeExtractor(
          { format: "pdf", text: "PDF content", pageCount: 3 },
          () => seen.push("pdf"),
        ),
        docx: fakeExtractor(
          { format: "docx", text: "DOCX content" },
          () => seen.push("docx"),
        ),
      },
    });
    const pdfPath = join(dir, "a.pdf");
    const docxPath = join(dir, "b.docx");
    await writeFile(pdfPath, Buffer.from("%PDF-1.4"));
    await writeFile(docxPath, Buffer.from("fake"));

    const r1 = await tool.run({ path: pdfPath }, makeCtx(dir));
    expect(r1.details.format).toBe("pdf");
    expect(r1.details.pageCount).toBe(3);
    expect(r1.summary).toContain("PDF content");

    const r2 = await tool.run({ path: docxPath }, makeCtx(dir));
    expect(r2.details.format).toBe("docx");
    expect(seen).toEqual(["pdf", "docx"]);
  });

  it("respects an explicit `format` override", async () => {
    const tool = buildOsFsReadDocumentTool({
      extractors: {
        plain: fakeExtractor({ format: "plain", text: "plain" }),
        pdf: fakeExtractor({ format: "pdf", text: "pdf" }),
      },
    });
    const weirdPath = join(dir, "unknown.bin");
    await writeFile(weirdPath, Buffer.from("hello"));
    const result = await tool.run(
      { path: weirdPath, format: "plain" },
      makeCtx(dir),
    );
    expect(result.details.format).toBe("plain");
  });

  it("rejects unknown extensions without a `format` override", async () => {
    const tool = buildOsFsReadDocumentTool({});
    const path = join(dir, "payload.bin");
    await writeFile(path, Buffer.from("x"));
    await expect(tool.run({ path }, makeCtx(dir))).rejects.toThrow(
      /unsupported extension/,
    );
  });

  // Issue #113: a `.py` handed to read_document used to produce a generic
  // "unsupported extension (override with `format`)" error, which sent
  // models into `format: "text"` — not a known format — instead of over to
  // os.fs.read. These pin both halves of the recovery hint.
  it.each(["py", "ts", "rs"])(
    "points .%s source files at os.fs.read and names format: \"plain\"",
    async (ext) => {
      const tool = buildOsFsReadDocumentTool({});
      const path = join(dir, `module.${ext}`);
      await writeFile(path, Buffer.from("print(1)\n"));

      const error = await tool
        .run({ path }, makeCtx(dir))
        .then(() => undefined)
        .catch((e: unknown) => e as Error);

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(`".${ext}" is a source/text file`);
      expect(message).toContain("use os.fs.read instead");
      expect(message).toContain('format: "plain"');
      // The ambiguous bare-`format` phrasing is what produced the bad
      // `format: "text"` guesses; it must not come back.
      expect(message).not.toMatch(/override with `format`/);
    },
  );

  it("offers os.fs.read and format: \"plain\" for an unknown binary extension", async () => {
    const tool = buildOsFsReadDocumentTool({});
    const path = join(dir, "blob.qzx");
    await writeFile(path, Buffer.from([0x00, 0x01, 0x02]));

    const error = await tool
      .run({ path }, makeCtx(dir))
      .then(() => undefined)
      .catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('unsupported extension ".qzx"');
    expect(message).toContain("os.fs.read");
    expect(message).toContain('format: "plain"');
  });

  it('reads a source file when format: "plain" is passed explicitly', async () => {
    const tool = buildOsFsReadDocumentTool({
      extractors: {
        plain: fakeExtractor({ format: "plain", text: "print(1)" }),
      },
    });
    const path = join(dir, "script.py");
    await writeFile(path, Buffer.from("print(1)\n"));

    const result = await tool.run({ path, format: "plain" }, makeCtx(dir));

    expect(result.details.format).toBe("plain");
    expect(result.summary).toContain("print(1)");
  });

  it("keeps document extensions routed to their own extractors", async () => {
    // Guards the other half of issue #113: the new source-file branch must
    // not have moved any real document format into the reject path.
    const seen: string[] = [];
    const tool = buildOsFsReadDocumentTool({
      extractors: {
        pdf: fakeExtractor({ format: "pdf", text: "p" }, () => seen.push("pdf")),
        docx: fakeExtractor({ format: "docx", text: "d" }, () => seen.push("docx")),
        xlsx: fakeExtractor({ format: "xlsx", text: "x" }, () => seen.push("xlsx")),
        rtf: fakeExtractor({ format: "rtf", text: "r" }, () => seen.push("rtf")),
        odt: fakeExtractor({ format: "odt", text: "o" }, () => seen.push("odt")),
        pptx: fakeExtractor({ format: "pptx", text: "s" }, () => seen.push("pptx")),
        plain: fakeExtractor({ format: "plain", text: "t" }, () => seen.push("plain")),
      },
    });
    for (const name of [
      "a.pdf",
      "a.docx",
      "a.xlsx",
      "a.rtf",
      "a.odt",
      "a.pptx",
      "a.txt",
      "a.md",
      "a.csv",
      "a.json",
      "a.yaml",
    ]) {
      const path = join(dir, name);
      await writeFile(path, Buffer.from("x"));
      await tool.run({ path }, makeCtx(dir));
    }
    expect(seen).toEqual([
      "pdf",
      "docx",
      "xlsx",
      "rtf",
      "odt",
      "pptx",
      "plain",
      "plain",
      "plain",
      "plain",
      "plain",
    ]);
  });

  it("rejects unknown format overrides", async () => {
    const tool = buildOsFsReadDocumentTool({});
    const path = join(dir, "any.txt");
    await writeFile(path, Buffer.from("x"));
    await expect(
      tool.run({ path, format: "quuxml" }, makeCtx(dir)),
    ).rejects.toThrow(/unknown format override/);
  });

  it("forwards pagination args to the extractor", async () => {
    let captured: ExtractorInput | undefined;
    const tool = buildOsFsReadDocumentTool({
      extractors: {
        pdf: fakeExtractor({ format: "pdf", text: "ok" }, (input) => {
          captured = input;
        }),
      },
    });
    const path = join(dir, "a.pdf");
    await writeFile(path, Buffer.from("%PDF"));
    await tool.run(
      {
        path,
        pagesFrom: 2,
        pagesTo: 5,
        maxPages: 4,
        pageSeparators: false,
        includeTables: false,
      },
      makeCtx(dir),
    );
    expect(captured?.pagesFrom).toBe(2);
    expect(captured?.pagesTo).toBe(5);
    expect(captured?.maxPages).toBe(4);
    expect(captured?.pageSeparators).toBe(false);
    expect(captured?.includeTables).toBe(false);
  });

  it("rejects pagesFrom > pagesTo", async () => {
    const tool = buildOsFsReadDocumentTool({});
    const path = join(dir, "a.pdf");
    await writeFile(path, Buffer.from("%PDF"));
    await expect(
      tool.run({ path, pagesFrom: 5, pagesTo: 2 }, makeCtx(dir)),
    ).rejects.toThrow(/pagesFrom must be <= pagesTo/);
  });

  it("truncates text when it exceeds maxBytes and sets truncated=true", async () => {
    const tool = buildOsFsReadDocumentTool({
      extractors: {
        plain: fakeExtractor({
          format: "plain",
          text: "x".repeat(10_000),
        }),
      },
    });
    const path = join(dir, "big.txt");
    await writeFile(path, Buffer.from("fake"));
    const result = await tool.run({ path, maxBytes: 100 }, makeCtx(dir));
    expect(result.details.truncated).toBe(true);
  });

  it("rejects non-files (directories)", async () => {
    const tool = buildOsFsReadDocumentTool({});
    await expect(tool.run({ path: dir }, makeCtx(dir))).rejects.toThrow(
      /is not a regular file/,
    );
  });

  it("passes sheets argument through for xlsx", async () => {
    let captured: ExtractorInput | undefined;
    const tool = buildOsFsReadDocumentTool({
      extractors: {
        xlsx: fakeExtractor({ format: "xlsx", text: "" }, (input) => {
          captured = input;
        }),
      },
    });
    const path = join(dir, "sheet.xlsx");
    await writeFile(path, Buffer.from("fake"));
    await tool.run(
      { path, sheets: ["Revenue", 2] },
      makeCtx(dir),
    );
    expect(captured?.sheets).toEqual(["Revenue", 2]);
  });

  it("rejects malformed sheets argument", async () => {
    const tool = buildOsFsReadDocumentTool({});
    const path = join(dir, "sheet.xlsx");
    await writeFile(path, Buffer.from("fake"));
    await expect(
      tool.run({ path, sheets: [{}] }, makeCtx(dir)),
    ).rejects.toThrow(/invalid sheet identifier/);
  });

  it("exposes warnings from extractor in details", async () => {
    const tool = buildOsFsReadDocumentTool({
      extractors: {
        pdf: fakeExtractor({
          format: "pdf",
          text: "",
          warnings: ["page 2 had no extractable text"],
        }),
      },
    });
    const path = join(dir, "a.pdf");
    await writeFile(path, Buffer.from("%PDF"));
    const result = await tool.run({ path }, makeCtx(dir));
    expect(result.details.warnings).toEqual([
      "page 2 had no extractable text",
    ]);
  });
});
