// ATO-981: Word, PowerPoint and Excel files in the preview panel.
// main/office-preview.ts and main/file-preview.ts are tested against the
// built output (npm run build), renderer/office-preview.js as a CommonJS
// module. The archives are made here by hand (no ZIP library in the app).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const { officePreview, officeTypeFor, looksZip, decodeXml, OFFICE_LIMITS } = require("../out/main/office-preview.js");
const { filePreview } = require("../out/main/file-preview.js");
const { fpOfficeHtml, ofColName } = require("../renderer/office-preview.js");
const { fpBodyHtml } = require("../renderer/file-preview.js");

const home = mkdtempSync(join(tmpdir(), "op-home-"));
after(() => rmSync(home, { recursive: true, force: true }));
const P = process.platform;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf);
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP of `files` ({name: string | Buffer}); `stored` names are not deflated. `lie` overrides a declared size. */
function zip(files, { stored = [], lie = {} } = {}) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const method = stored.includes(name) ? 0 : 8;
    const body = method === 0 ? data : zlib.deflateRawSync(data);
    const n = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const size = lie[name] ?? data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(n.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, body);
    centrals.push(ch, n);
    off += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const slide = (title, ...paras) => `<?xml version="1.0"?><p:sld ${A}><p:cSld><p:spTree>`
  + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>`
  + `<p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"/><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>`
  + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>`
  + paras.map((t) => `<a:p><a:pPr lvl="0"/><a:r><a:t>${t}</a:t></a:r></a:p>`).join("") + `<a:p><a:endParaRPr/></a:p>`
  + `</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

const PPTX = () => zip({
  "[Content_Types].xml": "<Types/>",
  "ppt/presentation.xml": "<p:presentation/>",
  // slide10 after slide2: the order is numeric, not by name.
  "ppt/slides/slide10.xml": slide("Third", "c"),
  "ppt/slides/slide1.xml": slide("Q3 &amp; Q4 plan", "Revenue up", "Costs <b>flat</b>".replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"))),
  "ppt/slides/slide2.xml": slide("Second", "a", "b"),
}, { stored: ["ppt/slides/slide2.xml"] });

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const DOCX = () => zip({
  "[Content_Types].xml": "<Types/>",
  "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>`
    + `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Report</w:t></w:r></w:p>`
    + `<w:p><w:r><w:t xml:space="preserve">Hello, </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>world</w:t></w:r><w:r><w:tab/><w:t>&#8364;5</w:t></w:r></w:p>`
    + `<w:p/><w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr></w:p>`
    + `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>`
    + `<w:sectPr/></w:body></w:document>`,
});

const XLSX = () => zip({
  "[Content_Types].xml": "<Types/>",
  "xl/workbook.xml": `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`
    + `<sheet name="Sales &amp; costs" sheetId="1" r:id="rId7"/><sheet name="Notes" sheetId="2" r:id="rId8"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Target="worksheets/data.xml" Type="x" Id="rId7"/><Relationship Id="rId8" Target="worksheets/sheet2.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst count="3"><si><t>Item</t></si><si><t>Price</t></si><si><r><t>Tea</t></r><r><t xml:space="preserve"> (green)</t></r></si></sst>`,
  "xl/worksheets/data.xml": `<worksheet><sheetData>`
    + `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>`
    + `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>0.30000000000000004</v></c><c r="D2" t="b"><v>1</v></c></row>`
    + `<row r="4"><c r="A4" t="inlineStr"><is><t>Total</t></is></c><c r="B4" t="str"><f>SUM(B2)</f><v>0.3</v></c></row>`
    + `</sheetData></worksheet>`,
  "xl/worksheets/sheet2.xml": `<worksheet><sheetData/></worksheet>`,
});

test("which files are Office files", () => {
  assert.equal(officeTypeFor(".PPTX"), "pptx");
  assert.equal(officeTypeFor(".docx"), "docx");
  assert.equal(officeTypeFor(".xlsx"), "xlsx");
  assert.equal(officeTypeFor(".zip"), null);
  assert.equal(officeTypeFor(".doc"), null, "the old binary formats are not ZIPs");
  assert.equal(looksZip(Buffer.from("PK\x03\x04rest", "latin1")), true);
  assert.equal(looksZip(Buffer.from("%PDF-")), false);
  assert.equal(decodeXml("a &amp; b &lt;c&gt; &quot;&apos; &#65;&#x1F600; &bogus;"), "a & b <c> \"' A\u{1F600} &bogus;");
});

test("a deck: slides in number order, each with its title and paragraphs", () => {
  const d = officePreview(PPTX(), "pptx");
  assert.equal(d.type, "pptx");
  assert.equal(d.total, 3);
  assert.equal(d.truncated, false);
  assert.deepEqual(d.slides.map((s) => s.title), ["Q3 & Q4 plan", "Second", "Third"]);
  assert.deepEqual(d.slides[0].paras, ["Revenue up", "Costs <b>flat</b>"], "the title is not repeated; entities decoded");
  assert.deepEqual(d.slides[1].paras, ["a", "b"], "a stored (not deflated) part reads too");
  assert.deepEqual(d.slides.map((s) => s.n), [1, 2, 3]);
});

test("a deck past the slide cap says it was cut", () => {
  const d = officePreview(PPTX(), "pptx", { ...OFFICE_LIMITS, slides: 2 });
  assert.equal(d.slides.length, 2);
  assert.equal(d.truncated, true);
});

test("a document: paragraphs joined from their runs, headings kept, blanks dropped", () => {
  const d = officePreview(DOCX(), "docx");
  assert.equal(d.type, "docx");
  assert.deepEqual(d.paras, [
    { text: "Report", heading: 1 },
    { text: "Hello, world\t€5" },
    { text: "<script>alert(1)</script>", heading: 2 },
  ]);
  const cut = officePreview(DOCX(), "docx", { ...OFFICE_LIMITS, chars: 8 });
  assert.equal(cut.truncated, true);
  assert.ok(cut.paras.map((p) => p.text).join("").length <= 8);
});

test("a workbook: sheet names, and the first sheet (through its relationship) as rows", () => {
  const d = officePreview(XLSX(), "xlsx");
  assert.equal(d.type, "xlsx");
  assert.deepEqual(d.sheets, ["Sales & costs", "Notes"]);
  assert.equal(d.sheet, "Sales & costs");
  assert.deepEqual(d.rows, [
    ["Item", "Price", "", ""],
    ["Tea (green)", "0.3", "", "TRUE"],
    ["", "", "", ""],
    ["Total", "0.3", "", ""],
  ]);
  const small = officePreview(XLSX(), "xlsx", { ...OFFICE_LIMITS, rows: 2, cols: 1 });
  assert.deepEqual(small.rows, [["Item"], ["Tea (green)"]]);
  assert.equal(small.truncated, true);
});

test("a zip bomb is refused, not inflated", () => {
  const big = Buffer.alloc(OFFICE_LIMITS.entryBytes + 1024, 0x41);
  // Declared honestly: refused before inflating.
  assert.equal(officePreview(zip({ "word/document.xml": big }), "docx"), null);
  // Declared small: zlib stops at the cap.
  assert.equal(officePreview(zip({ "word/document.xml": big }, { lie: { "word/document.xml": 10 } }), "docx"), null);
  // The total over all parts is capped too.
  const part = `<p:sld ${A}><a:p><a:t>${"x".repeat(1000)}</a:t></a:p></p:sld>`;
  const d = officePreview(zip({ "ppt/slides/slide1.xml": part, "ppt/slides/slide2.xml": part }), "pptx", { ...OFFICE_LIMITS, totalBytes: part.length + 10 });
  assert.equal(d.slides.length, 1);
  assert.equal(d.truncated, true);
});

// Parts of up to 8 MB inflated with many openings and no closing tag (a few
// KB compressed, under every byte cap). A scan that retries from each opening
// is quadratic and froze main; these must come back at once.
function timed(buf, type) {
  const t0 = performance.now();
  const d = officePreview(buf, type);
  return { d, ms: performance.now() - t0 };
}

test("a document with a million unclosed <w:p> openings is read in linear time", () => {
  for (const body of ["<w:p ".repeat(1_400_000), "<w:p>".repeat(1_400_000)]) {
    const { d, ms } = timed(zip({ "word/document.xml": body }), "docx");
    assert.ok(ms < 1000, `took ${Math.round(ms)} ms`);
    assert.equal(d.type, "docx");
    assert.deepEqual(d.paras, []);
  }
});

test("a slide with a million unclosed <a:p> openings is read in linear time", () => {
  const { d, ms } = timed(zip({ "ppt/slides/slide1.xml": "<a:p ".repeat(1_400_000) }), "pptx");
  assert.ok(ms < 1000, `took ${Math.round(ms)} ms`);
  assert.equal(d.type, "pptx");
  assert.deepEqual(d.slides, [{ n: 1, title: "", paras: [] }]);
  // A title shape of 300,000 paragraphs: taking them out of the body is one pass, not one copy each.
  const many = `<p:sld ${A}><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody>`
    + "<a:p><a:t>a</a:t></a:p>".repeat(300_000) + "</p:txBody></p:sp></p:sld>";
  const t = timed(zip({ "ppt/slides/slide1.xml": many }), "pptx");
  assert.ok(t.ms < 1000, `took ${Math.round(t.ms)} ms`);
  assert.equal(t.d.slides[0].title.length, OFFICE_LIMITS.chars);
  assert.deepEqual(t.d.slides[0].paras, []);
  assert.equal(t.d.truncated, true);
});

test("a sheet with a million unclosed <row>, <c> or <si> openings is read in linear time", () => {
  const wb = `<workbook><sheets><sheet name="S" sheetId="1"/></sheets></workbook>`;
  const cases = [
    { "xl/workbook.xml": wb, "xl/worksheets/sheet1.xml": "<row ".repeat(1_400_000) },
    { "xl/workbook.xml": wb, "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1">${"<c ".repeat(2_000_000)}</row></sheetData></worksheet>` },
    {
      "xl/workbook.xml": wb,
      "xl/sharedStrings.xml": "<si>".repeat(1_700_000),
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>`,
    },
  ];
  const rows = [[], [], [["7"]]];
  for (const [k, files] of cases.entries()) {
    const { d, ms } = timed(zip(files), "xlsx");
    assert.ok(ms < 1000, `case ${k} took ${Math.round(ms)} ms`);
    assert.equal(d.type, "xlsx");
    assert.deepEqual(d.sheets, ["S"]);
    assert.deepEqual(d.rows, rows[k]);
  }
});

test("anything that is not a readable Office file gives null, never a throw", () => {
  assert.equal(officePreview(Buffer.from("not a zip at all"), "docx"), null);
  assert.equal(officePreview(Buffer.alloc(0), "pptx"), null);
  const z = DOCX();
  assert.equal(officePreview(z.subarray(0, z.length - 10), "docx"), null, "cut short: no end record");
  assert.equal(officePreview(DOCX(), "pptx"), null, "a document named .pptx has no slides");
  assert.equal(officePreview(DOCX(), "xlsx"), null);
  const bad = Buffer.from(z);
  bad.writeUInt32LE(0xdeadbeef, bad.length - 6);   // the central directory's offset points nowhere
  assert.equal(officePreview(bad, "docx"), null);
  const garbage = Buffer.from(z);
  for (let i = 30; i < 80; i++) garbage[i] = 0xff;   // the deflated part itself is broken
  assert.equal(officePreview(garbage, "docx"), null);
});

test("filePreview: a real .docx on disk comes back as kind office", async () => {
  writeFileSync(join(home, "report.docx"), DOCX());
  const r = await filePreview(join(home, "report.docx"), [home], home, P);
  assert.equal(r.ok, true);
  assert.equal(r.kind, "office");
  assert.equal(r.office.type, "docx");
  assert.equal(r.office.paras[0].text, "Report");
  writeFileSync(join(home, "deck.pptx"), PPTX());
  assert.equal((await filePreview(join(home, "deck.pptx"), [home], home, P)).office.slides.length, 3);
  // Not a ZIP after all: the generic text preview, as before.
  writeFileSync(join(home, "fake.xlsx"), "just text");
  assert.equal((await filePreview(join(home, "fake.xlsx"), [home], home, P)).kind, "text");
  // A ZIP that is no workbook: name and size only.
  writeFileSync(join(home, "odd.xlsx"), zip({ "a.txt": "hi" }));
  const odd = await filePreview(join(home, "odd.xlsx"), [home], home, P);
  assert.equal(odd.kind, "other");
  assert.equal(odd.note, "binary");
  // Over the cap: not read.
  const tooBig = await filePreview(join(home, "report.docx"), [home], home, P, { office: 100 });
  assert.equal(tooBig.kind, "other");
  assert.equal(tooBig.note, "too-large");
});

test("the panel draws slides, a document and a sheet, every string escaped", () => {
  const deck = fpOfficeHtml({ kind: "office", office: officePreview(PPTX(), "pptx") });
  assert.match(deck, /class="fp-slide"/);
  assert.equal((deck.match(/class="fp-slide"/g) || []).length, 3);
  assert.match(deck, /Q3 &amp; Q4 plan/);
  assert.match(deck, /Costs &lt;b&gt;flat&lt;\/b&gt;/);
  assert.doesNotMatch(deck, /<b>flat/);

  const doc = fpOfficeHtml({ kind: "office", office: officePreview(DOCX(), "docx") });
  assert.match(doc, /<h2>Report<\/h2>/);
  assert.match(doc, /<h3>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h3>/);
  assert.doesNotMatch(doc, /<script>/);

  const sheet = fpOfficeHtml({ kind: "office", office: officePreview(XLSX(), "xlsx") });
  assert.match(sheet, /class="mdtbl fp-tbl"/, "the CSV preview's table");
  assert.match(sheet, /<th>A<\/th><th>B<\/th><th>C<\/th><th>D<\/th>/);
  assert.match(sheet, /Sales &amp; costs/);
  assert.match(sheet, /<td>Tea \(green\)<\/td>/);

  const cut = fpOfficeHtml({ kind: "office", office: { type: "pptx", slides: [{ n: 1, title: "<img src=x onerror=alert(1)>", paras: [] }], total: 9, truncated: true } });
  assert.match(cut, /Showing 1 of 9 slides/);
  assert.doesNotMatch(cut, /<img/);
  assert.match(fpOfficeHtml({ kind: "office" }), /could not be read/);
  assert.equal(ofColName(0), "A");
  assert.equal(ofColName(25), "Z");
  assert.equal(ofColName(26), "AA");
  assert.equal(ofColName(701), "ZZ");
  assert.equal(ofColName(702), "AAA");
});

test("file-preview.js hands an office preview to office-preview.js, loaded before it", () => {
  globalThis.fpOfficeHtml = fpOfficeHtml;
  try {
    const html = fpBodyHtml({ ok: true, kind: "office", name: "r.docx", ext: ".docx", size: 1, office: { type: "docx", paras: [{ text: "Hi" }], truncated: false } });
    assert.match(html, /<p>Hi<\/p>/);
  } finally {
    delete globalThis.fpOfficeHtml;
  }
  const src = readFileSync(new URL("../renderer/file-preview.js", import.meta.url), "utf8");
  assert.match(src, /if \(d\.kind === 'office' && typeof fpOfficeHtml === 'function'\) return fpOfficeHtml\(d\);/);
  const index = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const at = index.indexOf('<script src="office-preview.js"></script>');
  assert.ok(at > 0 && at < index.indexOf('<script src="file-preview.js"></script>'));
});
