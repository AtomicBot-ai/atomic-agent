// ATO-2445: the preview opened on a line, Open in editor, and Compare on a
// disk conflict. The renderer's files run together in a vm, in the order
// index.html loads them; line-diff.js is also loaded on its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const { lineDiff, unifiedDiff } = require("../renderer/line-diff.js");

function loadPanel(bridge) {
  const ctx = vm.createContext({ window: { atomic: bridge || {} }, setTimeout, clearTimeout, Intl, console, Promise });
  for (const f of ["diff-lines.js", "table-sort.js", "file-preview.js", "file-preview-edit.js", "line-diff.js",
    "file-preview-compare.js", "file-preview-line.js", "file-preview-editor.js"]) {
    vm.runInContext(readFileSync(join(HERE, "..", "renderer", f), "utf8"), ctx, { filename: f });
  }
  return (code) => vm.runInContext(code, ctx);
}
const doc = (over) => ({ ok: true, kind: "code", name: "a.py", ext: ".py", size: 9, mtimeMs: 100, path: "/h/a.py", text: "a\nb\nc\n", truncated: false, ...over });

/* ---- a line ---- */

test("a line's start and span in a text; past the end is none", () => {
  const run = loadPanel();
  assert.equal(run("fpLineOffset('a\\nbb\\nc', 1)"), 0);
  assert.equal(run("fpLineOffset('a\\nbb\\nc', 3)"), 5);
  assert.equal(run("fpLineOffset('a\\nbb\\nc', 4)"), -1);
  assert.equal(run("fpLineOffset('a', 0)"), -1);
  assert.equal(run("JSON.stringify(fpLineSpan('a\\nbbbb\\nc', 2, 3))"), JSON.stringify({ start: 2, end: 6, caret: 4 }));
  assert.equal(run("JSON.stringify(fpLineSpan('a\\nbb', 2, 99))"), JSON.stringify({ start: 2, end: 4, caret: 4 }), "the caret stays on the line");
  assert.equal(run("fpLineSpan('a', 5, 1)"), null);
});

test("opening on a line keeps it for one draw and shows a rendered kind as its source", () => {
  const run = loadPanel();
  run("FP.view = 'render'; fpLineSet({line: 42, col: 3});");
  assert.equal(run("JSON.stringify(FP.line)"), JSON.stringify({ line: 42, col: 3 }));
  assert.equal(run("FP.view"), "source", "line 42 of a Markdown file is a line of its source");
  assert.equal(run("FP.shownLine"), 42);
  run("fpLineSet({listed: true});");
  assert.equal(run("FP.line"), null);
  assert.equal(run("FP.shownLine"), 0, "another file opened without a line forgets the last one");
  assert.equal(run("fpLineNow()"), 0);
});

/* ---- Open in editor ---- */

test("Open in editor: no button without an editor, the editor's name for one, a menu for several", () => {
  const run = loadPanel();
  run("FP.data = " + JSON.stringify(doc()) + ";");
  run("FP_EDITORS.list = [];");
  assert.equal(run("fpEditorButtonHtml(FP.data)"), "");
  run("FP_EDITORS.list = [{id: 'cursor', name: 'Cursor'}];");
  const one = run("fpEditorButtonHtml(FP.data)");
  assert.match(one, /data-fpx="editor" data-fpx-id="cursor"/);
  assert.match(one, />Cursor</);
  assert.doesNotMatch(one, /data-fp="/, "not a [data-fp] button, which file-preview.js would take");
  run("FP_EDITORS.list = [{id: 'vscode', name: 'VS Code'}, {id: 'zed', name: 'Zed'}]; FP_EDITORS.menu = true;");
  const many = run("fpEditorButtonHtml(FP.data)");
  assert.match(many, /Open in…/);
  assert.match(many, /data-fpx-id="vscode">VS Code</);
  assert.match(many, /data-fpx-id="zed">Zed</);
  assert.equal(run("fpEditorButtonHtml({ok: false, reason: 'missing'})"), "", "no file, no button");
});

test("Open in editor asks main once for the editors and passes the line the reader is on", async () => {
  const calls = [];
  let asked = 0;
  const run = loadPanel({ editors: async () => { asked++; return [{ id: "vscode", name: "VS Code" }]; },
    openInEditor: async (...a) => { calls.push(a); return { ok: true }; } });
  run("FP.data = " + JSON.stringify(doc()) + "; FP.open = true; FP.path = '/h/a.py';");
  assert.equal(run("fpEditorButtonHtml(FP.data)"), "", "nothing until main answers");
  run("fpEditorButtonHtml(FP.data)");
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked, 1);
  run("fpLineSet({line: 7});");
  await run("fpEditorOpen('vscode')");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ["/h/a.py", "vscode", 7]);
});

/* ---- Compare ---- */

test("the line diff: changes in hunks with context, the same text is no diff", () => {
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n", "x", "y"), "");
  const d = unifiedDiff("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n10\n", "On disk", "Your changes");
  assert.equal(d, "--- On disk\n+++ Your changes\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+FIVE\n 6\n 7\n 8");
  const ops = lineDiff("a\nb\nc", "a\nc\nd");
  assert.deepEqual(ops.map((o) => o.op + o.text), [" a", "-b", " c", "+d"]);
  const far = unifiedDiff(Array.from({ length: 30 }, (_, i) => "l" + i).join("\n"),
    Array.from({ length: 30 }, (_, i) => (i === 1 || i === 25 ? "X" : "l" + i)).join("\n"), "a", "b");
  assert.equal((far.match(/^@@/gm) || []).length, 2, "two changes far apart are two hunks");
  assert.equal(unifiedDiff("", "new\n", "a", "b"), "--- a\n+++ b\n@@ -0,0 +1,1 @@\n+new");
});

test("a conflict offers Compare; it reads the file on disk and shows what Overwrite would change", async () => {
  const run = loadPanel({ filePreview: async () => doc({ text: "a\nB\nc\n", size: 30, mtimeMs: 300 }) });
  run("FP.open = true; FP.path = '/h/a.py'; FP.data = " + JSON.stringify(doc()) + "; FP.edit = fpEditState(FP.data); FP.edit.draft = 'a\\nb\\nc\\nd\\n'; FP.edit.conflict = {size: 30, mtimeMs: 300};");
  const bar = run("fpEditBarHtml(FP.edit)");
  assert.match(bar, /data-fp="edit-compare">Compare</);
  assert.match(bar, /data-fp="edit-reload">Reload from disk</);
  await run("fpCompareToggle()");
  const shown = run("fpEditBarHtml(FP.edit)");
  assert.match(shown, /Hide compare/);
  assert.match(shown, /dl-del">-B</);
  assert.match(shown, /dl-add">\+b</);
  assert.match(shown, /dl-add">\+d</);
  assert.match(shown, /remove 1 line from the file on disk and add 2 lines/);
  run("FP.edit.conflict = {size: 31, mtimeMs: 301};");
  assert.doesNotMatch(run("fpEditBarHtml(FP.edit)"), /fp-compare/, "a newer change on disk drops a diff made against the last one");
});

test("Compare says so when the file on disk cannot be compared", async () => {
  const run = loadPanel({ filePreview: async () => doc({ truncated: true }) });
  run("FP.open = true; FP.path = '/h/a.py'; FP.data = " + JSON.stringify(doc()) + "; FP.edit = fpEditState(FP.data); FP.edit.draft = 'x'; FP.edit.conflict = {size: 1, mtimeMs: 2};");
  await run("fpCompareToggle()");
  assert.match(run("fpEditBarHtml(FP.edit)"), /too long to compare here/);
});
