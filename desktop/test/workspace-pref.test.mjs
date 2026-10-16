// Unit tests for main/workspace-pref.ts, against the built output.
// Run: npm run build && npm run test:unit
// #680: the working folder picked in Settings survives a relaunch, the
// environment still wins, and a saved folder that is gone is ignored.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const W = require("../out/main/workspace-pref.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "workspace-pref-")); dirs.push(d); return d; };

test("a chosen folder round-trips through workspace.json", () => {
  const userData = scratch();
  const project = join(scratch(), "my project");
  mkdirSync(project);
  assert.equal(W.writeWorkspace(userData, project), true);
  assert.equal(W.readWorkspace(userData), project);
  assert.deepEqual(JSON.parse(readFileSync(join(userData, "workspace.json"), "utf8")), { dir: project });
});

test("no file, or a corrupt one, reads as null", () => {
  const userData = scratch();
  assert.equal(W.readWorkspace(userData), null);
  writeFileSync(join(userData, "workspace.json"), "{not json");
  assert.equal(W.readWorkspace(userData), null);
  writeFileSync(join(userData, "workspace.json"), JSON.stringify({ dir: 42 }));
  assert.equal(W.readWorkspace(userData), null);
  writeFileSync(join(userData, "workspace.json"), JSON.stringify({ dir: "relative/path" }));
  assert.equal(W.readWorkspace(userData), null);
  writeFileSync(join(userData, "workspace.json"), "null");
  assert.equal(W.readWorkspace(userData), null);
});

test("a saved folder that was deleted, or is now a file, reads as null", () => {
  const userData = scratch();
  const project = join(scratch(), "gone");
  mkdirSync(project);
  W.writeWorkspace(userData, project);
  rmSync(project, { recursive: true });
  assert.equal(W.readWorkspace(userData), null);
  writeFileSync(project, "now a file");
  assert.equal(W.readWorkspace(userData), null);
});

test("ATOMIC_AGENT_WORKSPACE wins, then the saved folder, then home", () => {
  assert.equal(W.startupWorkspace("/env/dir", "/saved/dir", "/home/me"), "/env/dir");
  assert.equal(W.startupWorkspace(undefined, "/saved/dir", "/home/me"), "/saved/dir");
  assert.equal(W.startupWorkspace(undefined, null, "/home/me"), "/home/me");
});

test("a Windows path survives the JSON round trip", () => {
  const userData = scratch();
  const win = "C:\\Users\\Ana\\Documents\\My Project";
  assert.equal(W.writeWorkspace(userData, win), true);
  assert.equal(W.parseWorkspacePref(readFileSync(join(userData, "workspace.json"), "utf8")), win);
  assert.equal(W.readWorkspace(userData, (d) => d === win), win);
  assert.equal(W.parseWorkspacePref(JSON.stringify({ dir: "\\\\server\\share\\repo" })), "\\\\server\\share\\repo");
});

test("a write into a folder that does not exist fails quietly", () => {
  assert.equal(W.writeWorkspace(join(scratch(), "missing", "deeper"), "/x"), false);
});

test("a folder that exists but cannot be entered reads as null", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const userData = scratch();
  const locked = join(scratch(), "locked");
  mkdirSync(locked);
  W.writeWorkspace(userData, locked);
  chmodSync(locked, 0o000);
  try {
    assert.equal(W.readWorkspace(userData), null);
  } finally {
    chmodSync(locked, 0o755);
  }
  assert.equal(W.readWorkspace(userData), locked);
});

/* ---- the wiring in main.ts, read as source ---- */

const mainSrc = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");

test("Choose folder saves the choice inside the app:chooseWorkspace handler", () => {
  const start = mainSrc.indexOf('ipcMain.handle("app:chooseWorkspace"');
  assert.ok(start >= 0, "app:chooseWorkspace handler not found");
  const next = mainSrc.indexOf("ipcMain.handle(", start + 1);
  const handler = mainSrc.slice(start, next < 0 ? undefined : next);
  assert.match(handler, /writeWorkspace\(\s*app\.getPath\(\s*"userData"\s*\)\s*,\s*dir\s*\)/);
});

test("boot starts in env, else the saved folder (not in smoke), else home", () => {
  assert.match(mainSrc, /startupWorkspace\(\s*process\.env\.ATOMIC_AGENT_WORKSPACE\s*,\s*SMOKE\s*\?\s*null\s*:\s*readWorkspace\(/);
  assert.doesNotMatch(mainSrc, /process\.env\.ATOMIC_AGENT_WORKSPACE\s*\?\?\s*homedir\(\)/);
});
