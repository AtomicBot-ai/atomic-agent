/**
 * Generate binary test fixtures for os.fs.read_document extractors.
 *
 * Run once via `npx tsx scripts/generate-fixtures.ts`; the resulting files
 * are committed to the repo under `src/tools/os/test-fixtures/` so CI does
 * not have to install heavy generator dependencies (pdfkit, docx) on every
 * run — those live in devDependencies and are only needed when refreshing
 * the fixtures.
 *
 * Legacy .doc (OLE2 BIFF) cannot be generated reliably in pure JS; the
 * doc-extractor test therefore mocks the `word-extractor` boundary instead
 * of loading a real fixture.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import ExcelJS from "exceljs";
import JSZip from "jszip";
import PDFDocument from "pdfkit";
import { pack as tarPack } from "tar-stream";
import {
  Document as DocxDocument,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
} from "docx";

const FIXTURES_DIR = resolve(
  new URL("../src/tools/os/test-fixtures", import.meta.url).pathname,
);

async function writeFixture(name: string, data: Buffer | Uint8Array): Promise<void> {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  await writeFile(join(FIXTURES_DIR, name), buf);
  console.log(`✓ wrote ${name} (${buf.length} bytes)`);
}

async function generatePdf(): Promise<void> {
  const doc = new PDFDocument({ autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on("data", (c) => chunks.push(c as Buffer));
  const done = new Promise<void>((res) => doc.on("end", () => res()));
  doc.addPage();
  doc.fontSize(20).text("Sample PDF");
  doc.fontSize(12).text("First page: hello from page 1.");
  doc.addPage();
  doc.fontSize(20).text("Second Page Heading");
  doc.fontSize(12).text("Second page: magos omnissiah vult.");
  doc.end();
  await done;
  await writeFixture("sample.pdf", Buffer.concat(chunks));
}

async function generateDocx(): Promise<void> {
  const doc = new DocxDocument({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun("Document Title")],
          }),
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun("Introduction")],
          }),
          new Paragraph({
            children: [
              new TextRun("The sacred rites of the Omnissiah are complete."),
            ],
          }),
          new Paragraph({
            children: [new TextRun("Second paragraph: all systems nominal.")],
          }),
        ],
      },
    ],
  });
  const buf = await Packer.toBuffer(doc);
  await writeFixture("sample.docx", buf);
}

async function generateXlsx(): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet("Revenue");
  s1.addRow(["Quarter", "Amount", "Notes"]);
  s1.addRow(["Q1", 1200, "Good"]);
  s1.addRow(["Q2", 1500, "Better"]);

  const s2 = wb.addWorksheet("Notes");
  s2.addRow(["Item", "Status"]);
  s2.addRow(["Blessing", "Complete"]);

  const buf = await wb.xlsx.writeBuffer();
  await writeFixture("sample.xlsx", Buffer.from(buf));
}

/**
 * Minimal but spec-compliant RTF fixture.
 * Uses only \par separators and ASCII content so any reasonable parser can
 * extract the text. Good enough to test the happy path.
 */
async function generateRtf(): Promise<void> {
  const body = [
    "{\\rtf1\\ansi\\ansicpg1252",
    "{\\fonttbl{\\f0\\fnil Calibri;}}",
    "\\f0\\fs24 Sample RTF document.\\par",
    "Second line: magos approves.\\par",
    "Third line: omnissiah vult.",
    "}",
  ].join("\n");
  await writeFixture("sample.rtf", Buffer.from(body, "utf8"));
}

/**
 * ODT is a Zip container with a mandatory `mimetype` first entry (STORED,
 * no compression) and a `content.xml` with the body text. We hand-craft a
 * minimal one — easier than pulling a library.
 */
async function generateOdt(): Promise<void> {
  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.text", {
    compression: "STORE",
  });
  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body>
    <office:text>
      <text:h text:outline-level="1">ODT Title</text:h>
      <text:p>First paragraph of the ODT fixture.</text:p>
      <text:p>Second paragraph: the sacred circuits hum.</text:p>
    </office:text>
  </office:body>
</office:document-content>`;
  zip.file("content.xml", contentXml);
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;
  zip.file("META-INF/manifest.xml", manifest);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await writeFixture("sample.odt", buf);
}

/**
 * PPTX is a Zip container with per-slide XML files under `ppt/slides/`.
 * Create two slides with a heading and body text each.
 */
async function generatePptx(): Promise<void> {
  const zip = new JSZip();
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;
  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`;
  const slideXml = (title: string, body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          <a:p><a:r><a:t>${title}</a:t></a:r></a:p>
          <a:p><a:r><a:t>${body}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rels);
  zip.file("ppt/presentation.xml", presentation);
  zip.file(
    "ppt/slides/slide1.xml",
    slideXml("Slide One", "First slide body content."),
  );
  zip.file(
    "ppt/slides/slide2.xml",
    slideXml("Slide Two", "Second slide body content."),
  );
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await writeFixture("sample.pptx", buf);
}

/**
 * Generate archive fixtures for os.fs.archive.* tools. The zip fixture is
 * built via JSZip (already a runtime dep), tar/tar.gz via tar-stream, and
 * `.gz` is a single-file gzip of a plain-text payload.
 *
 * Each fixture contains the same logical layout:
 *   hello.txt          "Hello from the archive."
 *   nested/world.txt   "Nested payload."
 *   empty/             (directory marker)
 * so the tool-level tests can check list + extract + read_entry uniformly.
 */
async function generateZipArchive(): Promise<void> {
  const zip = new JSZip();
  zip.file("hello.txt", "Hello from the archive.\n");
  zip.folder("nested")?.file("world.txt", "Nested payload.\n");
  zip.folder("empty");
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await writeFixture("sample.zip", buf);
}

function packTar(entries: Array<{ name: string; body?: Buffer; type: "file" | "directory" }>): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const pack = tarPack();
    const chunks: Buffer[] = [];
    pack.on("data", (c: Buffer) => chunks.push(c));
    pack.on("end", () => resolvePromise(Buffer.concat(chunks)));
    pack.on("error", rejectPromise);
    for (const entry of entries) {
      if (entry.type === "directory") {
        pack.entry({ name: entry.name, type: "directory" });
      } else {
        pack.entry({ name: entry.name, size: entry.body?.length ?? 0 }, entry.body ?? Buffer.alloc(0));
      }
    }
    pack.finalize();
  });
}

async function generateTarArchives(): Promise<void> {
  const entries: Array<{ name: string; body?: Buffer; type: "file" | "directory" }> = [
    { name: "hello.txt", body: Buffer.from("Hello from the archive.\n", "utf8"), type: "file" },
    { name: "nested/", type: "directory" },
    {
      name: "nested/world.txt",
      body: Buffer.from("Nested payload.\n", "utf8"),
      type: "file",
    },
    { name: "empty/", type: "directory" },
  ];
  const tar = await packTar(entries);
  await writeFixture("sample.tar", tar);
  await writeFixture("sample.tar.gz", gzipSync(tar));
}

async function generateGzFixture(): Promise<void> {
  const payload = Buffer.from("single file gzip payload\n", "utf8");
  await writeFixture("sample.txt.gz", gzipSync(payload));
}

async function generatePlain(): Promise<void> {
  await writeFixture(
    "sample.txt",
    Buffer.from("Plain text fixture.\nSecond line.\n", "utf8"),
  );
  await writeFixture(
    "sample.md",
    Buffer.from("# Title\n\nParagraph text.\n", "utf8"),
  );
}

async function main(): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });
  await generatePdf();
  await generateDocx();
  await generateXlsx();
  await generateRtf();
  await generateOdt();
  await generatePptx();
  await generatePlain();
  await generateZipArchive();
  await generateTarArchives();
  await generateGzFixture();
  console.log(`\nFixtures written to ${FIXTURES_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
