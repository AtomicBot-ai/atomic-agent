// ATO-2106: Settings › Models › "Models folder". main/models-folder.ts reads the
// agent's `localModels.managed.modelsDirOverride` and what `atag models dir`
// prints (against the built output: npm run build && npm run test:unit);
// renderer/models-folder.js draws the card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/models-folder.js");
const D = require("../out/main/disk-space.js");
const R = require("../renderer/models-folder.js");

const h = { esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]) };

test("the override is read from config.json, with ~ as the home folder", () => {
  const cfg = (v) => JSON.stringify({ localModels: { managed: { modelsDirOverride: v } } });
  assert.equal(M.modelsDirOverrideIn(cfg("/Volumes/Ext/models"), "/home/me"), resolve("/Volumes/Ext/models"));
  assert.equal(M.modelsDirOverrideIn(cfg("~/big/models"), "/home/me"), resolve("/home/me", "big/models"));
  assert.equal(M.modelsDirOverrideIn(cfg("  "), "/home/me"), null);
  assert.equal(M.modelsDirOverrideIn(cfg(null), "/home/me"), null);
  assert.equal(M.modelsDirOverrideIn(JSON.stringify({ localModels: {} }), "/home/me"), null);
  assert.equal(M.modelsDirOverrideIn("not json", "/home/me"), null);
});

test("modelsDirOverrideNow reads the state dir's config.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "atag-models-folder-"));
  try {
    assert.equal(M.modelsDirOverrideNow(dir), null);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ localModels: { managed: { modelsDirOverride: "/Volumes/Ext/m" } } }));
    assert.equal(M.modelsDirOverrideNow(dir), resolve("/Volumes/Ext/m"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every desktop model path follows the moved folder", () => {
  assert.equal(D.modelsDirOf("/data", "/Volumes/Ext/models"), "/Volumes/Ext/models");
  assert.equal(D.modelsDirOf("/data", null), join("/data", "models"));
});

test("what `atag models dir` prints is read back", () => {
  assert.deepEqual(M.parseModelsFolderInfo('{"dir":"/x/models","defaultDir":"/d/models","custom":true}\n'), { dir: "/x/models", defaultDir: "/d/models", custom: true });
  assert.equal(M.parseModelsFolderInfo("/x/models\n"), null);
  assert.deepEqual(M.parseModelsMoveLine("moving qwen-3.5-4b (2/5)"), { entry: "qwen-3.5-4b", index: 2, total: 5 });
  assert.equal(M.parseModelsMoveLine("moving x (6/5)"), null);
  assert.equal(M.parseModelsMoveLine("done"), null);
  const out = "moving a (1/1)\ncould not delete the old copy at /old/a; delete it by hand\nmodels folder: /Volumes/Ext/my models\n";
  assert.equal(M.movedToFromStdout(out), "/Volumes/Ext/my models");
  assert.deepEqual(M.leftoversFromStdout(out), ["/old/a"]);
});

test("the agent's refusals read as what to do", () => {
  assert.match(M.moveErrorWords("unknown subcommand: dir\n", 1), /Update the agent/);
  assert.match(M.moveErrorWords("models dir: a local model is running; stop it first (atomic-agent models stop)\n", 1), /Stop the local model first/);
  assert.match(M.moveErrorWords("models dir: a model download is running; pause or cancel it first\n", 1), /model download/);
  assert.equal(M.moveErrorWords("models dir: not enough free space in /x: 9.0 GB needed, 1.0 GB free\n", 1), "Not enough free space in /x: 9.0 GB needed, 1.0 GB free");
  // ATO-2742: no raw stderr or "exit code N" in the pane; that text goes behind Details.
  assert.equal(M.moveErrorWords("", 3), M.MOVE_FAILED_WORDS);
  assert.equal(M.moveErrorDetail("", 3), "exit code 3");
  assert.equal(M.moveErrorWords("Error: EACCES: permission denied, mkdir '/x'\n", 1), M.MOVE_FAILED_WORDS);
  assert.equal(M.moveErrorDetail("Error: EACCES: permission denied, mkdir '/x'\n", 1), "Error: EACCES: permission denied, mkdir '/x'");
  assert.equal(M.moveErrorDetail("models dir: not enough free space in /x: 9.0 GB needed, 1.0 GB free\n", 1), "");
  assert.equal(M.moveErrorDetail("models dir: a local model is running; stop it first\n", 1), "");
});

test("ATO-2742: the not-empty words name the folder dialog's own button on each system", () => {
  assert.match(M.notEmptyWords("darwin"), /with New Folder\.$/);
  assert.match(M.notEmptyWords("win32"), /with New folder\.$/);
  assert.match(M.notEmptyWords("linux"), /with Create Folder\.$/);
  const refusal = "models dir: the new folder C:\\Users\\me\\Docs is not empty; pick an empty folder or a new one\n";
  assert.equal(M.moveErrorWords(refusal, 1, "win32"), M.notEmptyWords("win32"));
});

test("the card shows the folder, Change, and the way back only for a moved folder", () => {
  assert.equal(R.mdirCardHTML({ info: null, phase: "idle" }, h), "");
  const plain = R.mdirCardHTML({ info: { dir: "/home/me/.atomic-agent/models", custom: false }, phase: "idle" }, h);
  assert.match(plain, /Models folder/);
  assert.match(plain, /\/home\/me\/\.atomic-agent\/models/);
  assert.match(plain, /data-mdir="change"/);
  assert.doesNotMatch(plain, /data-mdir="reset"/);
  const moved = R.mdirCardHTML({ info: { dir: "/Volumes/<Ext>", custom: true }, phase: "idle", error: "Stop the local model first" }, h);
  assert.match(moved, /data-mdir="reset"/);
  assert.match(moved, /\/Volumes\/&lt;Ext&gt;/);
  assert.match(moved, /role="alert">Stop the local model first/);
});

test("a move in progress says which model and hides the buttons", () => {
  const html = R.mdirCardHTML({ info: { dir: "/x", custom: true }, phase: "moving", progress: { entry: "qwen", index: 2, total: 3 } }, h);
  assert.match(html, /Moving qwen \(2 of 3\)/);
  assert.doesNotMatch(html, /data-mdir="change"/);
  assert.equal(R.mdirProgressLine(null), "Moving your models…");
  assert.match(R.mdirDoneNote({ leftovers: ["/old/a"] }), /could not be deleted\. Delete it yourself/);
});

test("ATO-2742: an old copy left behind is a file manager button and its path behind Details", () => {
  const note = R.mdirDoneNote({ leftovers: ["/old/models/a"] });
  assert.doesNotMatch(note, /\/old/, "no path in the sentence");
  const st = { info: { dir: "/x", custom: true }, phase: "idle", note, leftovers: ["/old/models/a"] };
  const html = R.mdirCardHTML(st, { ...h, canReveal: true, revealLabel: "Show in Explorer" });
  assert.match(html, /data-mdir="reveal">Show in Explorer<\/button>/);
  assert.match(html, /<details[^>]*><summary>Details<\/summary><code>\/old\/models\/a<\/code><\/details>/);
  assert.doesNotMatch(R.mdirCardHTML(st, { ...h, canReveal: false }), /data-mdir="reveal"/, "no bridge, no button");
  assert.equal(R.mdirParentOf("/old/models/a"), "/old/models");
  assert.equal(R.mdirParentOf("C:\\Users\\me\\models\\a\\"), "C:\\Users\\me\\models");
});

test("ATO-2742: a failed move shows plain words, and the raw text only behind Details", async () => {
  globalThis.BR = {
    modelsFolderInfo: async () => ({ ok: false }),
    modelsFolderMove: async () => ({ ok: false, error: M.MOVE_FAILED_WORDS, detail: "spawn atag ENOENT" }),
  };
  try {
    R.MDIR.phase = "idle";
    await R.mdirMove({ path: "/x" });
    assert.equal(R.MDIR.error, M.MOVE_FAILED_WORDS);
    assert.equal(R.MDIR.errorDetail, "spawn atag ENOENT");
    const html = R.mdirCardHTML({ ...R.MDIR, info: { dir: "/x", custom: false } }, h);
    assert.match(html, /role="alert">The models were not moved\. Try again\.<\/p><details[^>]*><summary>Details<\/summary><code>spawn atag ENOENT/);
  } finally {
    delete globalThis.BR;
    R.MDIR.error = null; R.MDIR.errorDetail = null;
  }
});

test("a folder with anything but .DS_Store in it is not empty, and the agent's refusal reads plainly", () => {
  assert.equal(M.folderListingIsEmpty([]), true);
  assert.equal(M.folderListingIsEmpty([".DS_Store"]), true);
  assert.equal(M.folderListingIsEmpty([".DS_Store", "letter.txt"]), false);
  assert.equal(
    M.moveErrorWords("models dir: the new folder /Users/me/Documents is not empty; pick an empty folder or a new one\n", 1),
    M.notEmptyWords(),
  );
});

test("ATO-2742: Windows Explorer's desktop.ini / Thumbs.db and the like do not make a folder non-empty", () => {
  assert.equal(M.folderListingIsEmpty(["desktop.ini"]), true);
  assert.equal(M.folderListingIsEmpty(["Thumbs.db", "Desktop.ini", "ehthumbs.db"]), true);
  assert.equal(M.folderListingIsEmpty(["._.DS_Store", ".DS_Store", ".directory"]), true);
  assert.equal(M.folderListingIsEmpty(["desktop.ini", "model.gguf"]), false);
  assert.equal(M.folderListingIsEmpty(["thumbs.db.bak"]), false);
});

test("Change shows the dialog's 'folder must be empty' error and moves nothing", async () => {
  let moved = false;
  globalThis.BR = {
    modelsFolderInfo: async () => ({ ok: true }),
    modelsFolderChoose: async () => ({ ok: false, error: M.notEmptyWords() }),
    modelsFolderMove: async () => { moved = true; return { ok: true }; },
  };
  try {
    R.MDIR.phase = "idle";
    R.MDIR.error = null;
    await R.mdirChange();
    assert.equal(R.MDIR.error, M.notEmptyWords());
    assert.equal(moved, false);
  } finally {
    delete globalThis.BR;
  }
});
