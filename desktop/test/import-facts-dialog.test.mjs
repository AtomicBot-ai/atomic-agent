// Unit tests for main/import-facts-dialog.ts (ATO-2740): the native dialog
// behind importFacts:pick lets Windows and Linux choose the unpacked export
// folder too, which the error words (import-facts-input.ts) already ask for.
// Electron cannot mix openFile and openDirectory there, so the window sends
// "file" or "folder". Against the built output.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const D = require("../out/main/import-facts-dialog.js");
const Input = require("../out/main/import-facts-input.js");
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("Windows and Linux: Choose folder opens a folder picker, Choose ZIP file a .zip picker", () => {
  for (const platform of ["win32", "linux"]) {
    const folder = D.factsPickDialogOptions("chatgpt", "folder", platform);
    assert.deepEqual(folder.properties, ["openDirectory"], platform);
    assert.equal(folder.filters, undefined, "a folder picker has no file filter");
    assert.match(folder.title, /folder/);
    const file = D.factsPickDialogOptions("chatgpt", "file", platform);
    assert.deepEqual(file.properties, ["openFile"], platform);
    assert.deepEqual(file.filters, [{ name: "ChatGPT data export", extensions: ["zip"] }]);
  }
});

test("Windows and Linux never get openFile and openDirectory in one dialog", () => {
  for (const platform of ["win32", "linux"]) {
    for (const kind of ["file", "folder", undefined, "both", 7]) {
      const p = D.factsPickDialogOptions("claude", kind, platform).properties;
      assert.ok(!(p.includes("openFile") && p.includes("openDirectory")), platform + " " + String(kind));
    }
  }
});

test("macOS keeps one dialog for the .zip or the folder; an explicit kind is honoured there too", () => {
  const mac = D.factsPickDialogOptions("claude", undefined, "darwin");
  assert.deepEqual(mac.properties, ["openFile", "openDirectory"]);
  assert.deepEqual(mac.filters, [{ name: "Claude data export", extensions: ["zip"] }]);
  assert.deepEqual(D.factsPickDialogOptions("claude", "folder", "darwin").properties, ["openDirectory"]);
});

test("only file and folder come through from the window", () => {
  assert.equal(D.factsPickKind("file"), "file");
  assert.equal(D.factsPickKind("folder"), "folder");
  assert.equal(D.factsPickKind("openDirectory"), null);
  assert.equal(D.factsPickKind(null), null);
  assert.deepEqual(D.factsPickDialogOptions("chatgpt", { kind: "folder" }, "win32").properties, ["openFile"], "a junk kind is the .zip picker");
});

test("the IPC route uses these options, and the start check still takes a folder and refuses a relative path", () => {
  const ipc = src("../main/import-facts-ipc.ts");
  assert.match(ipc, /ipcMain\.handle\("importFacts:pick", async \(_event, source: unknown, kind: unknown\) =>/);
  assert.match(ipc, /const opts = factsPickDialogOptions\(source, kind\);/);
  assert.doesNotMatch(ipc, /process\.platform === "darwin" \? \["openFile", "openDirectory"\] : \["openFile"\]/);
  const dir = { isFile: () => false, isDirectory: () => true, size: 0 };
  const abs = resolve("chatgpt-export");   // absolute on whichever OS runs the test
  assert.deepEqual(Input.checkFactsExportPath(abs, () => dir), { ok: true, path: abs }, "a picked folder is accepted");
  assert.equal(Input.checkFactsExportPath("chatgpt-export", () => dir).ok, false, "ATO-1656: a relative path is still refused");
  assert.match(Input.FACTS_INPUT_TEXT.notZip, /folder it was unpacked to/, "the words ask for what the dialog now allows on every OS");
});
