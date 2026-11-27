// ATO-2517: the rest of ATO-2410's slide pictures. A failed conversion is
// tried again on Reload (and only then); PowerPoint draws a deck on Windows
// without LibreOffice; Quick Look's page says when it left charts out; the
// panel's "Show text" brings the cards back. Tested against the built output
// (npm run build) with a stub converter; throwaway folders only.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const { QLMANAGE, deckHasCharts, pickOutput, slidesRenderableWith } = require("../out/main/slide-render-plan.js");
const { renderSlides, slidesRenderable } = require("../out/main/slide-render.js");
const {
  powerPointCandidates, powerShellPath, psLiteral, powerPointScript, powerPointPlan, POWERPOINT_PDF_NAME,
} = require("../out/main/slide-render-powerpoint.js");
const { fpOfficeHtml, ofViewButton } = require("../renderer/office-preview.js");

const home = mkdtempSync(join(tmpdir(), "sr2-home-"));
const tmp = mkdtempSync(join(tmpdir(), "sr2-tmp-"));
after(() => { for (const d of [home, tmp]) rmSync(d, { recursive: true, force: true }); });

/** A stored (uncompressed) ZIP of `files`, enough for openZip. */
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
  const count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const LOCAL_RELS = '<Relationships><Relationship Id="rId1" Type="x/image" Target="../media/image1.png"/></Relationships>';
const EXTERNAL_RELS = '<Relationships><Relationship Id="rId2" Type="x/image" Target="http://example.invalid/p.png" TargetMode="External"/></Relationships>';
const deckBytes = (rels = LOCAL_RELS, extra = {}) => storedZip({ "ppt/slides/slide1.xml": "<p:sld/>", "ppt/slides/_rels/slide1.xml.rels": rels, ...extra });
let n = 0;
function deck(bytes = deckBytes(), name = `deck${++n}.pptx`) {
  const p = join(home, name);
  writeFileSync(p, bytes);
  return p;
}
function stub(write) {
  const calls = [];
  const run = async (command, args, timeoutMs) => {
    calls.push({ command, args, timeoutMs });
    return { ok: (await write(command, args, calls.length)) !== false };
  };
  return { calls, run };
}
const outDirOf = (args) => args[args.indexOf(args.includes("-o") ? "-o" : "--outdir") + 1];
const pdfTo = (dir, name = "deck.pdf") => writeFileSync(join(dir, name), "%PDF-1.7\n%slides\n");

test("a failed conversion is kept for its version, but Reload (retry) converts it again", async () => {
  const file = deck();
  let works = false;
  const s = stub((_cmd, args) => { if (!works) return false; pdfTo(outDirOf(args)); });
  const deps = { env: { PATH: "" }, home, tmp, exists: (p) => p === "/usr/bin/soffice", run: s.run };
  assert.equal(await renderSlides(file, "linux", deps), null, "LibreOffice crashed");
  assert.equal(await renderSlides(file, "linux", deps), null, "the poll or a reopen does not start it again");
  assert.equal(s.calls.length, 1);
  works = true;
  const r = await renderSlides(file, "linux", deps, { retry: true });
  assert.equal(r && r.kind, "pdf", "Reload tried again and got the slides");
  assert.equal(s.calls.length, 2);
  const again = await renderSlides(file, "linux", deps, { retry: true });
  assert.equal(again, r, "a retry never redoes a conversion that worked");
  assert.equal(s.calls.length, 2);
});

test("PowerPoint's place and the PowerShell that drives it, on Windows", () => {
  const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", SystemRoot: "D:\\Win" };
  const c = powerPointCandidates(env);
  assert.equal(c[0], "C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE", "Microsoft 365 first");
  assert.ok(c.includes("C:\\Program Files (x86)\\Microsoft Office\\Office15\\POWERPNT.EXE"));
  assert.deepEqual(powerPointCandidates({}), []);
  assert.equal(powerShellPath(env), "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(powerShellPath({}), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(slidesRenderableWith("win32", null, () => false, true), true);
  assert.equal(slidesRenderableWith("linux", null, () => false, true), false, "PowerPoint counts on Windows only");
  assert.equal(pickOutput("powerpoint", ["x.qlpreview", POWERPOINT_PDF_NAME]), POWERPOINT_PDF_NAME);
});

test("a path goes into the script as a literal: quotes doubled, curly ones too, control characters refused", () => {
  assert.equal(psLiteral("C:\\a\\deck.pptx"), "'C:\\a\\deck.pptx'");
  assert.equal(psLiteral("C:\\Nadia's $(calc) `x`.pptx"), "'C:\\Nadia''s $(calc) `x`.pptx'", "nothing inside single quotes is expanded");
  assert.equal(psLiteral("C:\\a\u2019b\u2018c.pptx"), "'C:\\a\u2019\u2019b\u2018\u2018c.pptx'");
  assert.equal(psLiteral("C:\\a\nb.pptx"), null);
  assert.equal(psLiteral(""), null);
  assert.equal(powerPointScript("C:\\a\rb.pptx", "C:\\o\\slides.pdf"), null);
  const script = powerPointScript("C:\\d.pptx", "C:\\o\\slides.pdf");
  assert.match(script, /\$app\.Presentations\.Open\('C:\\d\.pptx', -1, 0, 0\)/, "read-only, no window");
  assert.match(script, /\$deck\.SaveAs\('C:\\o\\slides\.pdf', 32\)/, "ppSaveAsPDF");
  assert.match(script, /if \(\$app\.Presentations\.Count -eq 0\) \{ \$app\.Quit\(\) \}/, "the person's own decks keep PowerPoint open");
  assert.match(script, /\$app\.DisplayAlerts = \$alerts/, "the alert setting is put back");
  const plan = powerPointPlan("C:\\ps.exe", "C:\\d.pptx", "C:\\o\\slides.pdf");
  assert.equal(plan.kind, "powerpoint");
  assert.deepEqual(plan.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.equal(Buffer.from(plan.args[4], "base64").toString("utf16le"), script, "the script itself, as UTF-16LE base64");
  assert.equal(powerPointPlan("C:\\ps.exe", "C:\\d\n.pptx", "C:\\o\\slides.pdf"), null);
});

const WIN = { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" };
const PPT = "C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE";
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
/** What PowerPoint would do: the PDF at the path the script saves to. */
function savedTo(args) {
  const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
  return /SaveAs\('((?:[^']|'')*)', 32\)/.exec(script)[1].replace(/''/g, "'");
}

test("Windows with PowerPoint and no LibreOffice: PowerPoint saves the PDF the panel shows", async () => {
  const file = deck();
  const s = stub((_cmd, args) => writeFileSync(savedTo(args), "%PDF-1.7\n%powerpoint\n"));
  const deps = { env: WIN, home, tmp, exists: (p) => p === PPT || p === PS, run: s.run };
  assert.equal(slidesRenderable("win32", deps), true);
  assert.equal(slidesRenderable("win32", { ...deps, exists: (p) => p === PPT }), false, "no PowerShell, no PowerPoint plan");
  const r = await renderSlides(file, "win32", deps);
  assert.equal(r.kind, "pdf");
  assert.equal(Buffer.from(r.base64, "base64").toString("latin1"), "%PDF-1.7\n%powerpoint\n");
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].command, PS);
  assert.ok(savedTo(s.calls[0].args).startsWith(join(tmp, "atomic-agent-slides-")), "its own temporary folder, never beside the deck");
  assert.ok(Buffer.from(s.calls[0].args[4], "base64").toString("utf16le").includes(file));
});

test("Windows: LibreOffice first, PowerPoint when it fails; a linked deck goes to neither", async () => {
  const soffice = "C:\\Program Files\\LibreOffice\\program\\soffice.com";
  const s = stub((cmd, args) => (cmd === PS ? writeFileSync(savedTo(args), "%PDF-1.7\n") : false));
  const deps = { env: WIN, home, tmp, exists: (p) => p === PPT || p === PS || p === soffice, run: s.run };
  const r = await renderSlides(deck(), "win32", deps);
  assert.equal(r && r.kind, "pdf");
  assert.deepEqual(s.calls.map((c) => c.command), [soffice, PS]);
  const none = stub(() => assert.fail("nothing may open a deck that links outside its file"));
  assert.equal(await renderSlides(deck(deckBytes(EXTERNAL_RELS)), "win32", { ...deps, run: none.run }), null);
  assert.equal(none.calls.length, 0);
});

test("Quick Look's page says when the deck has charts it left out", async () => {
  const { openZip } = require("../out/main/office-preview.js");
  const charted = deckBytes(LOCAL_RELS, { "ppt/charts/chart1.xml": "<c:chartSpace/>" });
  assert.equal(deckHasCharts(openZip(charted)), true);
  assert.equal(deckHasCharts(openZip(deckBytes())), false);
  assert.equal(deckHasCharts(null), false);
  const ql = stub((_cmd, args) => {
    const dir = join(outDirOf(args), args[args.length - 1].split("/").pop() + ".qlpreview");
    mkdirSync(dir);
    writeFileSync(join(dir, "Preview.html"), "<html><body>slides</body></html>");
  });
  const deps = { env: { PATH: "" }, home, tmp, exists: (p) => p === QLMANAGE, run: ql.run };
  const r = await renderSlides(deck(charted), "darwin", deps);
  assert.equal(r.kind, "html");
  assert.equal(r.charts, true);
  const plain = await renderSlides(deck(), "darwin", deps);
  assert.equal(plain.charts, undefined);
  const office = { type: "pptx", slides: [{ n: 1, title: "Hi", paras: [] }], renderable: true };
  const html = fpOfficeHtml({ ok: true, kind: "office", name: "d.pptx", office: { ...office, render: { ok: true, ...r } } });
  assert.match(html, /Charts are not drawn in this view/);
  assert.match(html, /data-fp-slides="1"/, "the pictures are still shown");
  assert.doesNotMatch(fpOfficeHtml({ ok: true, kind: "office", name: "d.pptx", office: { ...office, render: { ok: true, ...plain } } }), /Charts are not/);
});

test("Show text: the cards again over the pictures, and back; a failed drawing says Reload tries again", () => {
  const office = { type: "pptx", slides: [{ n: 1, title: "Plan", paras: ["Ship it"] }], total: 1, renderable: true,
    render: { ok: true, kind: "pdf", base64: "JVBERi0=" } };
  const d = { ok: true, kind: "office", name: "d.pptx", office };
  assert.match(ofViewButton(d, "render"), /data-fp="view"[^>]*>Show text<\/button>$/);
  assert.match(ofViewButton(d, "source"), />Show slides<\/button>$/);
  assert.equal(ofViewButton({ ...d, office: { ...office, render: undefined } }, "render"), "", "no pictures: nothing to switch");
  assert.equal(ofViewButton({ ok: true, kind: "office", office: { type: "docx", paras: [] } }, "render"), "");
  assert.match(fpOfficeHtml(d, "render"), /^<iframe class="fp-frame fp-pdf"/);
  const text = fpOfficeHtml(d, "source");
  assert.match(text, /class="fp-slide"/);
  assert.doesNotMatch(text, /<iframe|Drawing the slides/, "the cards alone, no wait note under pictures that are there");
  const failed = fpOfficeHtml({ ...d, office: { ...office, render: undefined, renderFailed: true } });
  assert.match(failed, /could not be drawn as pictures[^<]*Reload to try again/);
  assert.doesNotMatch(fpOfficeHtml({ ...d, office: { ...office, render: undefined, renderable: false } }), /Reload to try again/);
});

test("the wiring: Reload asks main to retry, the poll does not; preload and main pass it on", () => {
  const fp = readFileSync(new URL("../renderer/file-preview.js", import.meta.url), "utf8");
  assert.match(fp, /what === 'refresh'\) \{ if \(FP\.open\) fpLoad\(true, true\); \}/);
  assert.match(fp, /else await fpLoad\(true\);/, "the poll's reload is no retry");
  assert.match(fp, /fpLoadSlides\(seq, path, res, retry === true\)/);
  assert.match(fp, /br\.filePreviewSlides\(path, retry === true\)/);
  assert.match(fp, /fpOfficeHtml\(d, FP\.view\)/);
  assert.match(fp, /typeof ofViewButton === 'function' \? ofViewButton\(d, FP\.view\)/);
  const pre = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.match(pre, /filePreviewSlides: \(path: string, retry\?: boolean\) => ipcRenderer\.invoke\("app:filePreviewSlides", path, retry === true\)/);
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.match(main, /renderSlides\(t\.real, process\.platform, \{\}, \{ retry: retry === true \}\)/);
});
