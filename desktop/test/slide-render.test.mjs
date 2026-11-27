// ATO-2410: a .pptx deck's slides drawn as pictures for the preview panel.
// main/slide-render-plan.ts and main/slide-render.ts are tested against the
// built output (npm run build); the converter is a stub that writes what
// LibreOffice or Quick Look would. Throwaway folders only.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const {
  sofficeCandidates, findSoffice, slidesRenderableWith, converterPlans, pickOutput, isAttachmentName,
  inlineAttachments, quickLookWidth, QLMANAGE, QUICKLOOK_DEFAULT_WIDTH, deckLinksOut,
} = require("../out/main/slide-render-plan.js");
const { renderSlides, slidesRenderable } = require("../out/main/slide-render.js");
const { fpOfficeHtml, ofSlidesDoc } = require("../renderer/office-preview.js");
const { fpPdfBase64, fpSlidesZoom, FP_HTML_CSP } = require("../renderer/file-preview.js");

const home = mkdtempSync(join(tmpdir(), "sr-home-"));
const tmp = mkdtempSync(join(tmpdir(), "sr-tmp-"));
after(() => { for (const d of [home, tmp]) rmSync(d, { recursive: true, force: true }); });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]);
/** A real (stored, uncompressed) ZIP of `files` {name: text}, enough for office-preview.ts's openZip. */
function storedZip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8"), nm = Buffer.from(name, "utf8"), crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, data); centrals.push(ch, nm);
    off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const LOCAL_RELS = '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>';
const EXTERNAL_RELS = '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://example.invalid/pixel.png" TargetMode="External"/></Relationships>';
/** A deck's bytes: a ZIP with one slide and its relationships (local unless `rels` says otherwise). */
const deckBytes = (rels = LOCAL_RELS, extra = {}) => storedZip({ "ppt/slides/slide1.xml": "<p:sld/>", "ppt/slides/_rels/slide1.xml.rels": rels, ...extra });
const ZIP_HEAD = deckBytes();
let n = 0;
/** A file that passes as a deck (its extension and first bytes), with a name of its own so the cache cannot confuse two. */
function deck(name = `deck${++n}.pptx`, bytes = ZIP_HEAD) {
  const p = join(home, name);
  writeFileSync(p, bytes);
  return p;
}
/** Where a plan's command writes: Quick Look's `-o dir`, LibreOffice's `--outdir dir`. */
function outDirOf(args) {
  const k = args.indexOf(args.includes("-o") ? "-o" : "--outdir");
  return args[k + 1];
}
/** A stub converter that records its calls and writes what `write(outDir, command)` says. */
function stub(write) {
  const calls = [];
  const run = async (command, args, timeoutMs) => {
    calls.push({ command, args, timeoutMs });
    return { ok: write(outDirOf(args), command, args) !== false };
  };
  return { calls, run };
}
function quickLookOutput(outDir, file, html, pictures = {}, plist = "") {
  const dir = join(outDir, file.split("/").pop() + ".qlpreview");
  mkdirSync(dir);
  writeFileSync(join(dir, "Preview.html"), html);
  if (plist) writeFileSync(join(dir, "PreviewProperties.plist"), plist);
  for (const [name, bytes] of Object.entries(pictures)) writeFileSync(join(dir, name), bytes);
}

test("where LibreOffice is looked for, per platform", () => {
  const mac = sofficeCandidates("darwin", { PATH: "/opt/homebrew/bin:/usr/bin" }, "/Users/n");
  assert.equal(mac[0], "/Applications/LibreOffice.app/Contents/MacOS/soffice");
  assert.ok(mac.includes("/Users/n/Applications/LibreOffice.app/Contents/MacOS/soffice"));
  assert.ok(mac.includes("/opt/homebrew/bin/soffice"), "PATH entries after the fixed places");
  const win = sofficeCandidates("win32", { ProgramFiles: "C:\\Program Files", PATH: "C:\\Tools;D:\\x" }, "C:\\Users\\n");
  assert.equal(win[0], "C:\\Program Files\\LibreOffice\\program\\soffice.com", "the console launcher first: it waits for the conversion");
  assert.equal(win[1], "C:\\Program Files\\LibreOffice\\program\\soffice.exe");
  assert.ok(win.includes("C:\\Tools\\soffice.com") && win.includes("D:\\x\\soffice.exe"));
  const linux = sofficeCandidates("linux", { PATH: "/usr/bin" }, "/home/n");
  assert.equal(linux[0], "/usr/bin/soffice");
  assert.ok(linux.includes("/snap/bin/libreoffice") && linux.includes("/usr/bin/libreoffice"));
  assert.equal(new Set(linux).size, linux.length, "no candidate twice");
  assert.equal(findSoffice(["/a", "/b", "/c"], (p) => p === "/b" || p === "/c"), "/b");
  assert.equal(findSoffice(["/a"], () => { throw new Error("eacces"); }), null);
});

test("a machine can draw slides with LibreOffice anywhere, or Quick Look on a Mac", () => {
  assert.equal(slidesRenderableWith("linux", "/usr/bin/soffice", () => false), true);
  assert.equal(slidesRenderableWith("linux", null, () => true), false, "nothing on Linux without LibreOffice");
  assert.equal(slidesRenderableWith("win32", null, () => true), false);
  assert.equal(slidesRenderableWith("darwin", null, (p) => p === QLMANAGE), true);
  assert.equal(slidesRenderableWith("darwin", null, () => false), false);
  assert.equal(slidesRenderable("linux", { exists: () => false }), false);
  assert.equal(slidesRenderable("linux", { env: { PATH: "/x" }, exists: (p) => p === "/x/soffice" }), true);
});

test("the converters to try, in order, as plain arguments", () => {
  const both = converterPlans("darwin", "/Users/n/deck.pptx", "/tmp/out", "file:///tmp/prof", "/Applications/LibreOffice.app/Contents/MacOS/soffice");
  assert.deepEqual(both.map((p) => p.kind), ["soffice", "quicklook"], "LibreOffice first: it is the one that draws charts");
  const lo = both[0];
  assert.equal(lo.command, "/Applications/LibreOffice.app/Contents/MacOS/soffice");
  assert.ok(lo.args.includes("--headless") && lo.args.includes("--norestore"));
  assert.ok(lo.args.includes("-env:UserInstallation=file:///tmp/prof"), "its own profile: a running LibreOffice does not take the request over");
  assert.deepEqual(lo.args.slice(lo.args.indexOf("--convert-to"), lo.args.indexOf("--convert-to") + 4), ["--convert-to", "pdf", "--outdir", "/tmp/out"]);
  assert.equal(lo.args[lo.args.length - 1], "/Users/n/deck.pptx", "the file last, as one argument");
  assert.ok(lo.timeoutMs >= 60_000, "a cold start takes over ten seconds");
  const ql = both[1];
  assert.equal(ql.command, QLMANAGE);
  assert.deepEqual(ql.args, ["-p", "-o", "/tmp/out", "/Users/n/deck.pptx"]);
  assert.deepEqual(converterPlans("darwin", "/d.pptx", "/o", "file:///p", null).map((p) => p.kind), ["quicklook"]);
  assert.deepEqual(converterPlans("win32", "C:\\d.pptx", "C:\\o", "file:///C:/p", null), [], "Windows without LibreOffice: the cards stay");
  assert.deepEqual(converterPlans("linux", "/d.pptx", "/o", "file:///p", "/usr/bin/soffice").map((p) => p.kind), ["soffice"]);
});

test("the converter's output is picked by what it is, not by the deck's name", () => {
  assert.equal(pickOutput("soffice", ["a.pptx", "My deck.pdf"]), "My deck.pdf");
  assert.equal(pickOutput("soffice", ["a.qlpreview"]), null);
  assert.equal(pickOutput("quicklook", ["x.pdf", "Deck (2).pptx.qlpreview"]), "Deck (2).pptx.qlpreview");
  assert.equal(isAttachmentName("Attachment12.png"), true);
  assert.equal(isAttachmentName("Attachment1.jpeg"), true);
  assert.equal(isAttachmentName("Preview.html"), false);
  assert.equal(isAttachmentName("../Attachment1.png"), false);
  assert.equal(isAttachmentName("Attachment.png"), false);
});

test("Quick Look's pictures are inlined as data: URLs; anything else is left alone", () => {
  const pics = new Map([["Attachment1.png", "data:image/png;base64,AAAA"]]);
  const html = '<img src="Attachment1.png" style="x"><img style="y" src=\'Attachment1.png\'><img src="Attachment2.png"><a href="Attachment1.png">';
  const out = inlineAttachments(html, pics);
  assert.equal(out, '<img src="data:image/png;base64,AAAA" style="x"><img style="y" src="data:image/png;base64,AAAA"><img src="Attachment2.png"><a href="Attachment1.png">');
  assert.equal(inlineAttachments(html, new Map()), html);
  assert.equal(quickLookWidth('<dict><key>Height</key><real>418</real><key>Width</key><real>753</real></dict>'), 753);
  assert.equal(quickLookWidth('<key>Width</key>\n\t<real>1024.5</real>'), 1025);
  assert.equal(quickLookWidth('<key>Width</key><real>7</real>'), QUICKLOOK_DEFAULT_WIDTH, "out of reason: the usual width");
  assert.equal(quickLookWidth(""), QUICKLOOK_DEFAULT_WIDTH);
});

test("Quick Look: the page comes back with its pictures inlined and its width, once per version of the file", async () => {
  const file = deck();
  const plist = '<plist><dict><key>Width</key><real>900</real></dict></plist>';
  const s = stub((outDir, _cmd, args) => quickLookOutput(outDir, args[args.length - 1],
    '<html><head></head><body><img src="Attachment1.png"><img src="Attachment2.svg"><img src="Attachment3.png"></body></html>',
    { "Attachment1.png": PNG, "Attachment2.svg": Buffer.from("<svg onload=x/>"), "Attachment3.png": Buffer.from("not a picture"), "notes.txt": Buffer.from("x") },
    plist));
  const deps = { platform: "darwin", env: { PATH: "" }, home, tmp, exists: () => false, run: s.run };
  const r = await renderSlides(file, "darwin", deps);
  assert.equal(r.kind, "html");
  assert.equal(r.width, 900);
  assert.match(r.html, /<img src="data:image\/png;base64,iVBOR[^"]+"><img src="Attachment2.svg"><img src="Attachment3.png">/,
    "a PNG by its bytes is inlined; an SVG and a file that is no picture are not");
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].command, QLMANAGE);
  assert.equal(s.calls[0].args[0], "-p");
  assert.equal(s.calls[0].args[3], file);
  assert.ok(s.calls[0].args[2].startsWith(join(tmp, "atomic-agent-slides-")), "its own temporary folder, never beside the deck");
  const again = await renderSlides(file, "darwin", deps);
  assert.equal(again, r, "the same version of the file is not converted twice");
  assert.equal(s.calls.length, 1);
  // Rewritten: a new version, converted again.
  await new Promise((done) => setTimeout(done, 20));
  writeFileSync(file, deckBytes(LOCAL_RELS, { "ppt/slides/slide2.xml": "<p:sld/>" }));
  await renderSlides(file, "darwin", deps);
  assert.equal(s.calls.length, 2);
});

test("LibreOffice: the PDF comes back as base64; its output folder is gone afterwards", async () => {
  const file = deck("Quarterly report.pptx");
  let outSeen = "";
  const s = stub((outDir) => { outSeen = outDir; writeFileSync(join(outDir, "Quarterly report.pdf"), "%PDF-1.7\n%slides\n"); });
  const deps = { env: { PATH: "" }, home, tmp, exists: (p) => p === "/usr/bin/soffice", run: s.run };
  const r = await renderSlides(file, "linux", deps);
  assert.equal(r.kind, "pdf");
  assert.equal(Buffer.from(r.base64, "base64").toString("latin1"), "%PDF-1.7\n%slides\n");
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].command, "/usr/bin/soffice");
  assert.ok(s.calls[0].args.includes("--headless") && s.calls[0].args.includes("pdf"));
  assert.ok(s.calls[0].args.some((a) => a.startsWith("-env:UserInstallation=file://") && a.endsWith("atomic-agent-soffice-profile")));
  assert.equal(s.calls[0].args[s.calls[0].args.length - 1], file);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(outSeen), false, "the temporary folder is removed");
});

test("LibreOffice failing on a Mac falls back to Quick Look; nothing at all gives null and the cards stay", async () => {
  const s = stub((outDir, cmd, args) => {
    if (cmd !== QLMANAGE) return false;   // LibreOffice: a timeout or a crash
    quickLookOutput(outDir, args[args.length - 1], "<html><body>slides</body></html>");
  });
  const deps = { env: { PATH: "" }, home, tmp, exists: (p) => p === "/Applications/LibreOffice.app/Contents/MacOS/soffice", run: s.run };
  const r = await renderSlides(deck(), "darwin", deps);
  assert.equal(r.kind, "html");
  assert.deepEqual(s.calls.map((c) => c.command), ["/Applications/LibreOffice.app/Contents/MacOS/soffice", QLMANAGE]);
  // Not a PDF after all: nothing is shown as one.
  const bad = stub((outDir) => writeFileSync(join(outDir, "x.pdf"), "<html>not a pdf</html>"));
  assert.equal(await renderSlides(deck(), "linux", { env: { PATH: "" }, home, tmp, exists: (p) => p === "/usr/bin/soffice", run: bad.run }), null);
  // Windows without LibreOffice: no converter, nothing run.
  const none = stub(() => assert.fail("nothing to run"));
  assert.equal(await renderSlides(deck(), "win32", { env: {}, home, tmp, exists: () => false, run: none.run }), null);
  assert.equal(none.calls.length, 0);
});

test("only a deck is handed to a converter", async () => {
  const s = stub(() => assert.fail("must not run"));
  const deps = { env: { PATH: "" }, home, tmp, exists: () => true, run: s.run };
  assert.equal(await renderSlides(deck("report.docx"), "darwin", deps), null, "a document is not a deck");
  assert.equal(await renderSlides(deck("text.pptx", Buffer.from("just text")), "darwin", deps), null, "named .pptx but no ZIP");
  assert.equal(await renderSlides(join(home, "missing.pptx"), "darwin", deps), null);
  assert.equal(await renderSlides(home, "darwin", deps), null, "a folder");
  assert.equal(s.calls.length, 0);
});

test("the panel: pictures when main drew them, cards with a wait note until then, cards alone when it could not", () => {
  const office = { type: "pptx", slides: [{ n: 1, title: "Hi", paras: ["a"] }], total: 1, truncated: false, renderable: true };
  const waiting = fpOfficeHtml({ kind: "office", name: "d.pptx", office });
  assert.match(waiting, /class="fp-note fp-wait">Drawing the slides/);
  assert.match(waiting, /class="fp-slide"/, "the cards are there meanwhile");
  const failed = fpOfficeHtml({ kind: "office", name: "d.pptx", office: { ...office, renderFailed: true } });
  assert.doesNotMatch(failed, /Drawing the slides/);
  assert.match(failed, /class="fp-slide"/);
  const plain = fpOfficeHtml({ kind: "office", name: "d.pptx", office: { ...office, renderable: false } });
  assert.doesNotMatch(plain, /Drawing the slides/, "no converter on this machine: no promise of pictures");
  const pdf = fpOfficeHtml({ kind: "office", name: 'd"<.pptx', office: { ...office, render: { ok: true, kind: "pdf", base64: "JVBERi0=" } } });
  assert.match(pdf, /^<iframe class="fp-frame fp-pdf" data-fp-pdf="1" title="d&quot;&lt;\.pptx"><\/iframe>$/, "the PDF frame, no cards");
  const page = fpOfficeHtml({ kind: "office", name: "d.pptx", office: { ...office, render: { ok: true, kind: "html", html: "<html>x</html>", width: 753 } } });
  assert.match(page, /^<iframe class="fp-frame fp-slides" data-fp-slides="1" sandbox="" referrerpolicy="no-referrer" title="d\.pptx"><\/iframe>$/);
  const odd = fpOfficeHtml({ kind: "office", name: "d.pptx", office: { ...office, render: { ok: true, kind: "pdf", base64: "" } } });
  assert.match(odd, /class="fp-slide"/, "an empty answer is no picture");
  assert.equal(fpPdfBase64({ ok: true, kind: "pdf", base64: "AAAA" }), "AAAA");
  assert.equal(fpPdfBase64({ ok: true, kind: "office", office: { ...office, render: { ok: true, kind: "pdf", base64: "BBBB" } } }), "BBBB");
  assert.equal(fpPdfBase64({ ok: true, kind: "office", office }), "");
  assert.equal(fpPdfBase64({ ok: false, reason: "missing" }), "");
});

test("Quick Look's page is framed with the HTML preview's CSP and a zoom, in quirks mode", () => {
  const doc = ofSlidesDoc('<html><head><meta charset="utf-8"><style>p{}</style></head><body>s</body></html>', FP_HTML_CSP, 0.56789);
  assert.doesNotMatch(doc, /^<!doctype/i, "a doctype would turn its unitless lengths off");
  assert.ok(doc.startsWith('<html><head><meta http-equiv="Content-Security-Policy" content="' + FP_HTML_CSP + '">'), "the CSP before anything of the page");
  assert.match(doc, /<style>html,body\{margin:0;padding:0 0 8px\}body\{zoom:0\.568\}<\/style><meta charset="utf-8"><style>p\{\}<\/style>/);
  assert.match(FP_HTML_CSP, /default-src 'none'/);
  const bare = ofSlidesDoc("<div>no head</div>", FP_HTML_CSP, 1.5);
  assert.ok(bare.startsWith('<meta http-equiv="Content-Security-Policy"'));
  assert.match(bare, /body\{zoom:1\}/, "never zoomed up");
  assert.ok(bare.endsWith("<div>no head</div>"));
  assert.equal(fpSlidesZoom({ clientWidth: 376 }, 753), 376 / 753);
  assert.equal(fpSlidesZoom({ clientWidth: 1000 }, 753), 1);
  assert.equal(fpSlidesZoom(null, 753), 1);
});

test("a deck that links outside its file is never handed to LibreOffice (review of ATO-2410)", async () => {
  const { openZip } = require("../out/main/office-preview.js");
  assert.equal(deckLinksOut(openZip(deckBytes())), false, "local pictures only: LibreOffice may draw it");
  assert.equal(deckLinksOut(openZip(deckBytes(EXTERNAL_RELS))), true, "a linked picture");
  assert.equal(deckLinksOut(openZip(deckBytes(EXTERNAL_RELS.replace('"External"', "'external'")))), true, "any quoting or case");
  assert.equal(deckLinksOut(null), true, "not an archive: fails closed");
  assert.equal(deckLinksOut({ entries: new Map([["ppt/_rels/presentation.xml.rels", {}]]), read: () => null }), true, "an unreadable .rels: fails closed");
  // On Linux (LibreOffice only) a linked deck runs nothing and keeps its cards.
  const lo = stub(() => assert.fail("LibreOffice must not open a linked deck"));
  const linux = { env: { PATH: "" }, home, tmp, exists: (p) => p === "/usr/bin/soffice", run: lo.run };
  assert.equal(await renderSlides(deck("linked.pptx", deckBytes(EXTERNAL_RELS)), "linux", linux), null);
  assert.equal(lo.calls.length, 0);
  // On a Mac it goes straight to Quick Look.
  const s = stub((outDir, cmd, args) => { assert.equal(cmd, QLMANAGE); quickLookOutput(outDir, args[args.length - 1], "<html><body>slides</body></html>"); });
  const mac = { env: { PATH: "" }, home, tmp, exists: (p) => p === "/Applications/LibreOffice.app/Contents/MacOS/soffice" || p === QLMANAGE, run: s.run };
  const r = await renderSlides(deck("linked-mac.pptx", deckBytes(EXTERNAL_RELS)), "darwin", mac);
  assert.equal(r.kind, "html");
  assert.deepEqual(s.calls.map((c) => c.command), [QLMANAGE]);
});
