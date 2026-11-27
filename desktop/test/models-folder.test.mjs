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
