// ATO-2445: "Open in editor" finds VS Code, Cursor and Zed on PATH and where
// their installers put them, on macOS, Windows and Linux, and opens a file at
// a line. main/editor-detect.ts is tested against the built output
// (npm run build) with a stand-in for the file system.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { detectEditors, editorArgs, editorCandidates, editorEnv, readEditorId, searchDirs } = require("../out/main/editor-detect.js");

const only = (...paths) => (p) => paths.includes(p);

test("macOS: the app bundles' own tools, and PATH plus the folders a Dock-started app misses", () => {
  const e = { platform: "darwin", home: "/Users/n", env: { PATH: "/usr/bin:/bin" } };
  const found = detectEditors({ ...e, runnable: only("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", "/opt/homebrew/bin/zed") });
  assert.deepEqual(found.map((x) => [x.id, x.name, x.command]), [
    ["vscode", "VS Code", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"],
    ["zed", "Zed", "/opt/homebrew/bin/zed"],
  ]);
  assert.ok(editorCandidates("cursor", e).includes("/Users/n/Applications/Cursor.app/Contents/Resources/app/bin/cursor"));
  assert.ok(editorCandidates("zed", e).includes("/Applications/Zed.app/Contents/MacOS/cli"));
  assert.ok(searchDirs(e).includes("/usr/local/bin"));
  assert.deepEqual(detectEditors({ ...e, runnable: () => false }), [], "none found: no button");
});

test("Windows: the editor's own .exe, never a .cmd; the .exe next to a .cmd on PATH", () => {
  const env = { Path: "C:\\Users\\n\\AppData\\Local\\Programs\\Microsoft VS Code\\bin;C:\\Users\\n\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin",
    LOCALAPPDATA: "C:\\Users\\n\\AppData\\Local", ProgramFiles: "C:\\Program Files" };
  const e = { platform: "win32", home: "C:\\Users\\n", env };
  const code = editorCandidates("vscode", e);
  assert.equal(code[0], "C:\\Users\\n\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe");
  assert.ok(code.includes("C:\\Program Files\\Microsoft VS Code\\Code.exe"));
  assert.ok(editorCandidates("cursor", e).includes("C:\\Users\\n\\AppData\\Local\\Programs\\cursor\\Cursor.exe"));
  assert.ok(editorCandidates("zed", e).includes("C:\\Users\\n\\AppData\\Local\\Programs\\Zed\\Zed.exe"));
  for (const id of ["vscode", "cursor", "zed"]) {
    assert.ok(editorCandidates(id, e).every((c) => !/\.cmd$/i.test(c)), id + ": a .cmd would need a shell");
  }
  const found = detectEditors({ ...e, runnable: only("C:\\Users\\n\\AppData\\Local\\Programs\\cursor\\Cursor.exe") });
  assert.deepEqual(found.map((x) => x.id), ["cursor"]);
});

test("Linux: PATH, then the packages' own folders; Zed may be zeditor", () => {
  const e = { platform: "linux", home: "/home/n", env: { PATH: "/usr/bin" } };
  assert.ok(editorCandidates("vscode", e).includes("/usr/share/code/bin/code"));
  assert.ok(editorCandidates("zed", e).includes("/usr/bin/zeditor"));
  assert.deepEqual(detectEditors({ ...e, runnable: only("/snap/bin/code") }).map((x) => x.id), ["vscode"]);
});

test("the line: -g file:line for VS Code and Cursor, file:line for Zed, the bare file without one", () => {
  assert.deepEqual(editorArgs("vscode", "/w/a.ts", 42), ["-g", "/w/a.ts:42"]);
  assert.deepEqual(editorArgs("cursor", "/w/a.ts", 42, 7), ["-g", "/w/a.ts:42:7"]);
  assert.deepEqual(editorArgs("zed", "/w/a.ts", 42), ["/w/a.ts:42"]);
  assert.deepEqual(editorArgs("vscode", "/w/a.ts"), ["/w/a.ts"]);
  assert.deepEqual(editorArgs("zed", "/w/a.ts", 0, 5), ["/w/a.ts"], "a column without a line is dropped");
  assert.deepEqual(editorArgs("vscode", "C:\\w\\a.ts", 3), ["-g", "C:\\w\\a.ts:3"]);
});

test("only the three editors, and never this app's Electron and Node variables", () => {
  assert.equal(readEditorId("vscode"), "vscode");
  assert.equal(readEditorId("/bin/sh"), null);
  assert.equal(readEditorId(undefined), null);
  const env = editorEnv({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--x" });
  assert.deepEqual(env, { PATH: "/bin" });
});
