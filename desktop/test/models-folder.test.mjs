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
  assert.deepEqual(M.parseModelsFolderInfo('{"dir":"/x/models","defaultDir":"/d/models","custom":true}\n'), { dir: "/x/models", defaultDir: "/d/models", custom: true, reachable: true });
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
  assert.match(M.moveErrorWords("", 3), /exit code 3/);
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
  assert.match(R.mdirDoneNote({ leftovers: ["/old/a"] }), /delete it by hand: \/old\/a/);
});

test("a folder with anything but .DS_Store in it is not empty, and the agent's refusal reads plainly", () => {
  assert.equal(M.folderListingIsEmpty([]), true);
  assert.equal(M.folderListingIsEmpty([".DS_Store"]), true);
  assert.equal(M.folderListingIsEmpty([".DS_Store", "letter.txt"]), false);
  assert.equal(
    M.moveErrorWords("models dir: the new folder /Users/me/Documents is not empty; pick an empty folder or a new one\n", 1),
    M.NOT_EMPTY_WORDS,
  );
});

test("Change shows the dialog's 'folder must be empty' error and moves nothing", async () => {
  let moved = false;
  globalThis.BR = {
    modelsFolderInfo: async () => ({ ok: true }),
    modelsFolderChoose: async () => ({ ok: false, error: M.NOT_EMPTY_WORDS }),
    modelsFolderMove: async () => { moved = true; return { ok: true }; },
  };
  try {
    R.MDIR.phase = "idle";
    R.MDIR.error = null;
    await R.mdirChange();
    assert.equal(R.MDIR.error, M.NOT_EMPTY_WORDS);
    assert.equal(moved, false);
  } finally {
    delete globalThis.BR;
  }
});

// ATO-2503: bytes across disks, a hung move, an unplugged disk, Cancel.
test("byte lines of a move across disks are read back", () => {
  assert.deepEqual(M.parseModelsMoveBytes("copied 3100000000 of 12000000000 bytes (qwen-3.5-4b)"), { entry: "qwen-3.5-4b", done: 3100000000, size: 12000000000 });
  assert.equal(M.parseModelsMoveBytes("copied 5 of 0 bytes (x)"), null);
  assert.equal(M.parseModelsMoveBytes("copied 9 of 5 bytes (x)"), null);
  assert.equal(M.parseModelsMoveBytes("moving x (1/1)"), null);
  assert.ok(M.MOVE_QUIET_LIMIT_MS >= 60_000);
  assert.ok(M.MOVE_KILL_GRACE_MS > 0);
});

test("an unplugged disk, a move under way and a stopped move read as what to do", () => {
  assert.deepEqual(M.parseModelsFolderInfo('{"dir":"/Volumes/USB/m","defaultDir":"/d","custom":true,"reachable":false}'), { dir: "/Volumes/USB/m", defaultDir: "/d", custom: true, reachable: false });
  assert.match(M.moveErrorWords("models dir: the models folder /Volumes/USB/m is not there (is its disk connected?); connect it and try again\n", 1), /not connected/);
  assert.match(M.moveErrorWords("models dir: the models are already being moved; wait for that move to finish\n", 1), /already being moved/);
  assert.match(M.moveErrorWords("models dir: the move was stopped; every model is back in the old folder\n", 1), /back in the old folder/);
  assert.match(M.moveErrorWords("models dir: a local model is starting; wait for it\n", 1), /is starting/);
});

test("the progress line carries bytes across disks", () => {
  assert.equal(R.mdirBytes(12_000_000_000), "12.0 GB");
  assert.equal(R.mdirBytes(850_000_000), "850 MB");
  assert.equal(R.mdirProgressLine({ entry: "qwen", index: 1, total: 2, done: 3_100_000_000, size: 12_000_000_000 }), "Moving qwen (1 of 2), 3.1 of 12.0 GB copied…");
  assert.equal(R.mdirProgressLine({ entry: "qwen", index: 1, total: 2 }), "Moving qwen (1 of 2)…");
  const html = R.mdirCardHTML({ info: { dir: "/x", custom: true }, phase: "moving", progress: { entry: "qwen", index: 1, total: 1, done: 50, size: 100 } }, h);
  assert.match(html, /<progress[^>]*value="50"/);
  assert.match(html, /data-mdir="cancel"/);
});

test("a folder whose disk is not connected says so and offers only the default folder", () => {
  const html = R.mdirCardHTML({ info: { dir: "/Volumes/USB/m", custom: true, reachable: false }, phase: "idle" }, h);
  assert.match(html, /not connected/);
  assert.doesNotMatch(html, /data-mdir="change"/);
  assert.match(html, /data-mdir="reset"/);
  const ok = R.mdirCardHTML({ info: { dir: "/Volumes/USB/m", custom: true, reachable: true }, phase: "idle" }, h);
  assert.doesNotMatch(ok, /not connected/);
});

test("Cancel asks main once and shows Stopping", async () => {
  let asked = 0;
  globalThis.BR = { modelsFolderInfo: async () => ({ ok: true }), modelsFolderCancel: async () => { asked += 1; return { ok: true }; } };
  try {
    R.MDIR.phase = "moving";
    R.MDIR.cancelling = false;
    await R.mdirCancel();
    await R.mdirCancel();
    assert.equal(asked, 1);
    assert.equal(R.MDIR.cancelling, true);
    R.MDIR.info = { dir: "/x", custom: false };
    assert.match(R.mdirCardHTML(R.MDIR, h), /Stopping…/);
  } finally {
    R.MDIR.phase = "idle";
    R.MDIR.cancelling = false;
    delete globalThis.BR;
  }
});

test("Cancel the agent did not take gives the button back (ATO-2503)", async () => {
  globalThis.BR = { modelsFolderInfo: async () => ({ ok: true }), modelsFolderCancel: async () => ({ ok: false, error: "No move is under way." }) };
  try {
    R.MDIR.phase = "moving";
    R.MDIR.cancelling = false;
    await R.mdirCancel();
    assert.equal(R.MDIR.cancelling, false);
    R.MDIR.info = { dir: "/x", custom: false };
    const html = R.mdirCardHTML(R.MDIR, h);
    assert.match(html, /data-mdir="cancel">Cancel</);
  } finally {
    R.MDIR.phase = "idle";
    R.MDIR.cancelling = false;
    delete globalThis.BR;
  }
});
