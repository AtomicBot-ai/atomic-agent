// ATO-2347: editing a file in the preview panel, and sorting its CSV table.
// main/file-save.ts and main/file-save-check.ts are tested against the built
// output (npm run build); the renderer's table-sort.js, file-preview.js and
// file-preview-edit.js run together in a vm, as the window loads them.
// Throwaway folders only.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const { filePreviewSave } = require("../out/main/file-save.js");
const { changedOnDisk, readStamp, notEditable, hasBom } = require("../out/main/file-save-check.js");
const { filePreview } = require("../out/main/file-preview.js");
const { tsNumber, tsCompareCells, tsSortRows, tsNextSort } = require("../renderer/table-sort.js");

const home = mkdtempSync(join(tmpdir(), "fpe-home-"));
const outside = mkdtempSync(join(tmpdir(), "fpe-outside-"));
after(() => { for (const d of [home, outside]) rmSync(d, { recursive: true, force: true }); });
const roots = [home];
const P = process.platform;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const stampOf = async (p) => { const r = await filePreview(p, roots, home, P); return { size: r.size, mtimeMs: r.mtimeMs }; };

/* ---- main: the checks ---- */

test("changedOnDisk: another size or another time is a change; no stamp is never 'unchanged'", () => {
  assert.equal(changedOnDisk({ size: 3, mtimeMs: 10 }, { size: 3, mtimeMs: 10 }), false);
  assert.equal(changedOnDisk({ size: 3, mtimeMs: 10 }, { size: 4, mtimeMs: 10 }), true);
  assert.equal(changedOnDisk({ size: 3, mtimeMs: 10 }, { size: 3, mtimeMs: 10.5 }), true);
  assert.equal(changedOnDisk(null, { size: 3, mtimeMs: 10 }), true);
  assert.equal(readStamp({ size: 3, mtimeMs: 10 }).size, 3);
  assert.equal(readStamp({ size: "3", mtimeMs: 10 }), null);
  assert.equal(readStamp({ size: -1, mtimeMs: 10 }), null);
  assert.equal(readStamp(null), null);
});

test("notEditable: Office by name, pictures, PDF, ZIP and NUL bytes by content; text is editable", () => {
  assert.equal(notEditable(".docx", Buffer.from("plain")), "office");
  assert.equal(notEditable(".txt", PNG), "binary");
  assert.equal(notEditable(".txt", Buffer.from("%PDF-1.7")), "binary");
  assert.equal(notEditable(".txt", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1])), "binary");
  assert.equal(notEditable(".log", Buffer.from("a\0b")), "binary");
  assert.equal(notEditable(".md", Buffer.from("# hi\n")), null);
  assert.equal(notEditable(".txt", Buffer.alloc(0)), null);
  assert.equal(hasBom(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), true);
  assert.equal(hasBom(Buffer.from("a")), false);
});

/* ---- main: Save ---- */

test("Save writes the file when it is still the one the panel read", async () => {
  const f = join(home, "notes.md");
  writeFileSync(f, "# Old\nlonger text that will shrink\n");
  const r = await filePreviewSave(f, "# New\n", await stampOf(f), roots, home, P);
  assert.equal(r.ok, true);
  assert.equal(readFileSync(f, "utf8"), "# New\n", "written in place and cut to the new length");
  assert.equal(r.size, 6);
  const again = await filePreviewSave(f, "# Newer\n", { size: r.size, mtimeMs: r.mtimeMs }, roots, home, P);
  assert.equal(again.ok, true, "the stamp Save hands back is the one the next Save sends");
});

test("a file changed on disk since it was read is not written: 'changed', then Overwrite with force", async () => {
  const f = join(home, "plan.txt");
  writeFileSync(f, "mine!\n");
  const read = await stampOf(f);
  writeFileSync(f, "agent\n");   // the agent writes it meanwhile, same size
  utimesSync(f, new Date(), new Date(read.mtimeMs + 5000));
  const r = await filePreviewSave(f, "edited\n", read, roots, home, P);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "changed");
  assert.equal(typeof r.mtimeMs, "number");
  assert.equal(readFileSync(f, "utf8"), "agent\n", "nothing written over the agent's version");
  const missingStamp = await filePreviewSave(f, "edited\n", undefined, roots, home, P);
  assert.equal(missingStamp.reason, "changed", "no stamp never passes as unchanged");
  const forced = await filePreviewSave(f, "edited\n", read, roots, home, P, { force: true });
  assert.equal(forced.ok, true);
  assert.equal(readFileSync(f, "utf8"), "edited\n");
});

test("Save never writes outside the preview's roots, through a link out, or a file that is not there", async () => {
  const secret = join(outside, "secret.txt");
  writeFileSync(secret, "keep");
  const st = { size: 4, mtimeMs: 0 };
  assert.deepEqual(await filePreviewSave(secret, "x", st, roots, home, P, { force: true }), { ok: false, reason: "outside" });
  assert.deepEqual(await filePreviewSave(join(home, "..", "..", secret), "x", st, roots, home, P, { force: true }), { ok: false, reason: "outside" });
  symlinkSync(secret, join(home, "link.txt"));
  assert.deepEqual(await filePreviewSave(join(home, "link.txt"), "x", st, roots, home, P, { force: true }), { ok: false, reason: "outside" });
  assert.equal(readFileSync(secret, "utf8"), "keep");
  assert.equal((await filePreviewSave("file://" + secret, "x", st, roots, home, P, { force: true })).ok, false);
  const gone = join(home, "new.txt");
  assert.equal((await filePreviewSave(gone, "x", st, roots, home, P, { force: true })).reason, "missing");
  assert.equal(existsSync(gone), false, "Save never creates a file");
});

test("pictures, PDFs, Office files and binaries are refused even with force", async () => {
  writeFileSync(join(home, "pic.txt"), PNG);
  writeFileSync(join(home, "doc.pdf"), "%PDF-1.4\n");
  writeFileSync(join(home, "deck.pptx"), "not really a zip");
  writeFileSync(join(home, "blob.dat"), Buffer.from([1, 0, 2]));
  const st = { size: 0, mtimeMs: 0 };
  assert.equal((await filePreviewSave(join(home, "pic.txt"), "x", st, roots, home, P, { force: true })).reason, "binary");
  assert.equal((await filePreviewSave(join(home, "doc.pdf"), "x", st, roots, home, P, { force: true })).reason, "binary");
  assert.equal((await filePreviewSave(join(home, "deck.pptx"), "x", st, roots, home, P, { force: true })).reason, "office");
  assert.equal((await filePreviewSave(join(home, "blob.dat"), "x", st, roots, home, P, { force: true })).reason, "binary");
  assert.deepEqual(readFileSync(join(home, "pic.txt")), PNG);
});

test("a byte order mark is kept; text that is not a string or too long is refused", async () => {
  const f = join(home, "bom.csv");
  writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a,b\n")]));
  const r = await filePreviewSave(f, "a,c\n", await stampOf(f), roots, home, P);
  assert.equal(r.ok, true);
  assert.deepEqual([...readFileSync(f).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(readFileSync(f).subarray(3).toString("utf8"), "a,c\n");
  assert.equal((await filePreviewSave(f, 42, null, roots, home, P)).reason, "bad-text");
  assert.equal((await filePreviewSave(f, "x".repeat(11), null, roots, home, P, { maxBytes: 10 })).reason, "too-large");
});

test("a file that is not UTF-8 (Latin-1) is never saved and offers no Edit; its bytes stay", async () => {
  const f = join(home, "latin1.csv");
  const bytes = Buffer.from("name,city\nJos\xe9,M\xfcnchen\n", "latin1");
  writeFileSync(f, bytes);
  const read = await filePreview(f, roots, home, P);
  assert.equal(read.editable, false, "the panel must not offer Edit for a file it cannot write back");
  const r = await filePreviewSave(f, read.text, { size: read.size, mtimeMs: read.mtimeMs }, roots, home, P, { force: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-utf8");
  assert.deepEqual(readFileSync(f), bytes, "no U+FFFD written over the accented letters");
  const utf8 = join(home, "utf8.csv");
  writeFileSync(utf8, "name,city\nJos\u00e9,M\u00fcnchen\n");
  assert.equal((await filePreview(utf8, roots, home, P)).editable, true);
});

/* ---- renderer: the table's sort ---- */

test("tsNumber reads numbers with thousands commas, percents and exponents; nothing else", () => {
  assert.equal(tsNumber("1,234.5"), 1234.5);
  assert.equal(tsNumber(" -3 "), -3);
  assert.equal(tsNumber("12%"), 12);
  assert.equal(tsNumber("1e3"), 1000);
  assert.ok(Number.isNaN(tsNumber("12 apples")));
  assert.ok(Number.isNaN(tsNumber("1,23")));
  assert.ok(Number.isNaN(tsNumber("")));
});

test("tsSortRows: numbers by value, text naturally, empty cells last both ways, stable", () => {
  const rows = [["b", "10"], ["a", "9"], ["c", ""], ["d", "100"], ["e", "9"]];
  assert.deepEqual(tsSortRows(rows, 1, "asc").map((r) => r[0]), ["a", "e", "b", "d", "c"]);
  assert.deepEqual(tsSortRows(rows, 1, "desc").map((r) => r[0]), ["d", "b", "a", "e", "c"]);
  assert.deepEqual(tsSortRows([["file 10"], ["File 2"], ["file 1"]], 0, "asc").map((r) => r[0]), ["file 1", "File 2", "file 10"]);
  assert.ok(tsCompareCells("5", "abc") < 0, "numbers before text");
  assert.deepEqual(tsSortRows(rows, 1, null), rows, "no sort: the file's own order");
  assert.notEqual(tsSortRows(rows, 0, "asc"), rows, "a new array; the parsed rows stay as read");
  assert.deepEqual(tsSortRows([["x"], ["y"]], 3, "asc").map((r) => r[0]), ["x", "y"], "a column a row lacks counts as empty");
});

test("tsNextSort: ascending, descending, then the file's order", () => {
  assert.deepEqual(tsNextSort(null, 2), { col: 2, dir: "asc" });
  assert.deepEqual(tsNextSort({ col: 2, dir: "asc" }, 2), { col: 2, dir: "desc" });
  assert.equal(tsNextSort({ col: 2, dir: "desc" }, 2), null);
  assert.deepEqual(tsNextSort({ col: 2, dir: "desc" }, 0), { col: 0, dir: "asc" });
});

/* ---- renderer: the panel and its editor, run in a vm ---- */

function loadPanel(save, preview) {
  const calls = [];
  const ctx = vm.createContext({
    window: { atomic: { filePreview: preview || (async () => ({ ok: false, reason: "missing" })),
      filePreviewSave: async (...a) => { calls.push(a); return save(...a); } } },
    setTimeout, clearTimeout, Intl, console,
  });
  for (const f of ["table-sort.js", "file-preview.js", "file-preview-edit.js"]) {
    vm.runInContext(readFileSync(join(HERE, "..", "renderer", f), "utf8"), ctx, { filename: f });
  }
  return { run: (code) => vm.runInContext(code, ctx), calls };
}
const doc = (over) => ({ ok: true, kind: "markdown", name: "a.md", ext: ".md", size: 9, mtimeMs: 100, path: "/h/a.md", text: "# a\r\nb\r\n", truncated: false, ...over });

test("a CSV table sorts by the clicked column, within the rows shown", () => {
  const { run } = loadPanel(() => ({ ok: true }));
  const d = { ok: true, kind: "csv", name: "t.csv", ext: ".csv", size: 20, mtimeMs: 1, path: "/h/t.csv", text: "n,v\nb,10\na,9\nc,100\n" };
  run("FP.data = " + JSON.stringify(d) + "; FP.sort = null;");
  const plain = run("fpBodyHtml(FP.data)");
  assert.match(plain, /data-fp="sort" data-fp-col="1" aria-sort="none"/);
  assert.ok(plain.indexOf(">b<") < plain.indexOf(">a<"), "the file's order first");
  run("FP.sort = {col: 1, dir: 'desc'};");
  const sorted = run("fpBodyHtml(FP.data)");
  assert.match(sorted, /aria-sort="descending"/);
  const at = (v) => sorted.indexOf("<td>" + v + "</td>");
  assert.ok(at("100") < at("10") && at("10") < at("9"), "numbers by value, largest first");
});

test("Edit is offered only for text read whole, and shows a text area, never the text as markup", () => {
  const { run } = loadPanel(() => ({ ok: true }));
  assert.equal(run("fpEditable(" + JSON.stringify(doc()) + ")"), true);
  assert.equal(run("fpEditable(" + JSON.stringify(doc({ truncated: true })) + ")"), false, "a file cut at the cap would lose its end");
  assert.equal(run("fpEditable(" + JSON.stringify(doc({ kind: "office", text: undefined })) + ")"), false);
  assert.equal(run("fpEditable(" + JSON.stringify(doc({ kind: "image", text: undefined })) + ")"), false);
  run("FP.data = " + JSON.stringify(doc({ text: "<script>x</script>" })) + "; FP.edit = fpEditState(FP.data);");
  const html = run("fpBodyHtml(FP.data)");
  assert.match(html, /<textarea class="fp-editor"/);
  assert.doesNotMatch(html, /<script>/);
});

test("Save sends the file's own line ends and the stamp it read; the new stamp is kept", async () => {
  const { run, calls } = loadPanel(() => ({ ok: true, path: "/h/a.md", size: 12, mtimeMs: 200 }));
  run("FP.open = true; FP.path = '/h/a.md'; FP.data = " + JSON.stringify(doc()) + "; FP.edit = fpEditState(FP.data); FP.edit.draft = '# a\\nb\\nc\\n';");
  assert.equal(run("fpEditDirty(FP.edit)"), true);
  await run("fpEditSave(false)");
  // Through JSON: the call's objects come from the vm's realm.
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ["/h/a.md", "# a\r\nb\r\nc\r\n", { size: 9, mtimeMs: 100 }, false]);
  assert.equal(run("FP.stamp"), "12:200", "the panel's poll does not take its own write for a change");
  assert.equal(run("fpEditDirty(FP.edit)"), false);
  assert.equal(run("JSON.stringify(FP.edit.base)"), JSON.stringify({ size: 12, mtimeMs: 200 }));
});

test("a file changed on disk asks Reload from disk or Overwrite; Overwrite saves with force", async () => {
  let n = 0;
  const { run, calls } = loadPanel(() => (++n === 1 ? { ok: false, reason: "changed", size: 30, mtimeMs: 300 } : { ok: true, size: 5, mtimeMs: 400 }));
  run("FP.open = true; FP.path = '/h/a.md'; FP.data = " + JSON.stringify(doc()) + "; FP.edit = fpEditState(FP.data); FP.edit.draft = 'mine';");
  await run("fpEditSave(false)");
  assert.deepEqual(JSON.parse(run("JSON.stringify(FP.edit.conflict)")), { size: 30, mtimeMs: 300 });
  const bar = run("fpEditBarHtml(FP.edit)");
  assert.match(bar, /changed on disk/);
  assert.match(bar, /data-fp="edit-reload">Reload from disk</);
  assert.match(bar, /data-fp="edit-overwrite">Overwrite</);
  assert.equal(run("fpEditDirty(FP.edit)"), true, "the text typed is kept");
  await run("fpEditSave(true)");
  assert.equal(calls[1][3], true);
  assert.equal(run("FP.edit.conflict"), null);
});

test("leaving the editor with unsaved text asks first; with none it just leaves", () => {
  const { run } = loadPanel(() => ({ ok: true }));
  run("FP.data = " + JSON.stringify(doc()) + "; FP.edit = fpEditState(FP.data); globalThis.left = 0;");
  assert.equal(run("fpEditGuard(() => { left++; })"), false, "nothing typed: no question");
  assert.equal(run("FP.edit"), null);
  run("FP.edit = fpEditState(FP.data); FP.edit.draft = 'changed';");
  assert.equal(run("fpEditGuard(() => { left++; })"), true);
  assert.match(run("fpEditBarHtml(FP.edit)"), /Discard your unsaved changes\?/);
  assert.equal(run("left"), 0);
  run("fpEditClick('edit-discard')");
  assert.equal(run("left"), 1);
  assert.equal(run("FP.edit"), null);
});

test("a chat switch closing the panel keeps unsaved text; the file opened again brings the editor back with it", async () => {
  let disk = doc();
  const { run } = loadPanel(() => ({ ok: true }), async () => disk);
  run("FP.open = true; FP.path = '/h/a.md'; FP.data = " + JSON.stringify(doc()) + "; FP.edit = fpEditState(FP.data); FP.edit.draft = 'unsaved';");
  run("filePreviewClose()");   // what renderer.js does when another chat comes on screen
  assert.equal(run("FP.edit"), null);
  run("FP.open = true; FP.path = '/h/a.md';");
  await run("fpLoad(false)");
  assert.equal(run("FP.edit && FP.edit.draft"), "unsaved", "the draft is back in the editor");
  assert.equal(run("FP.edit.conflict"), null, "the file did not change meanwhile");
  assert.equal(run("fpEditDirty(FP.edit)"), true);
  // Changed on disk while the panel was shut: the editor comes back saying so.
  run("filePreviewShowList()");
  disk = doc({ size: 50, mtimeMs: 999 });
  run("FP.open = true; FP.path = '/h/a.md';");
  await run("fpLoad(false)");
  assert.equal(run("FP.edit.draft"), "unsaved");
  assert.equal(run("JSON.stringify(FP.edit.conflict)"), JSON.stringify({ size: 50, mtimeMs: 999 }));
  // Nothing typed: nothing kept, the file opens as a preview.
  run("fpEditStop(); FP.edit = fpEditState(FP.data); filePreviewClose(); FP.open = true; FP.path = '/h/a.md';");
  await run("fpLoad(false)");
  assert.equal(run("FP.edit"), null);
});

test("Edit is not offered when main says the file is not editable", () => {
  const { run } = loadPanel(() => ({ ok: true }));
  assert.equal(run("fpEditable(" + JSON.stringify(doc({ editable: false })) + ")"), false);
  assert.equal(run("fpEditable(" + JSON.stringify(doc({ editable: true })) + ")"), true);
});
