// ATO-2738: the preview before "Replace in <app>" (renderer/mini-chat-replace-preview.js
// with diff-lines.js), main's side of it (main/replace-preview.ts, built output),
// and the hooks in mini-chat.js, mini-chat-selection.js, mini-chat.html,
// quick-entry-window.ts and preload (read from the sources).
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const P = require("../out/main/replace-preview.js");
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/* The page's scripts in one context, the way mini-chat.html loads them. */
function page(answer) {
  const ctx = { console, asked: [], repaints: 0 };
  vm.createContext(ctx);
  for (const f of ["diff-lines.js", "mini-chat-replace-preview.js", "mini-chat-selection.js"]) {
    vm.runInContext(read("../renderer/" + f), ctx, { filename: f });
  }
  ctx.BR = { quickEntryReplacePreview: async (text) => { ctx.asked.push(text); return answer; } };
  ctx.st = { rows: [{ id: 7, k: "assistant", text: "Here is the text:\n\nNew line", replace: true }] };
  ctx.repaint = () => { ctx.repaints++; };
  return ctx;
}
const click = (attr, id) => ({ target: { closest: (sel) => (sel === "[" + attr + "]" ? { getAttribute: () => String(id) } : null) } });
const run = (ctx, code) => vm.runInContext(code, ctx);

test("the line diff: common lines kept, the rest removed then added; a huge pair is all old then all new", () => {
  const R = require("../renderer/mini-chat-replace-preview.js");
  assert.deepEqual(R.mcRpLineDiff("a\nb\nc", "a\nB\nc"), [
    { op: " ", text: "a" }, { op: "-", text: "b" }, { op: "+", text: "B" }, { op: " ", text: "c" },
  ]);
  assert.deepEqual(R.mcRpLineDiff("", "x"), [{ op: "+", text: "x" }]);
  assert.equal(R.mcRpDiffText("old\r\nsame", "new\nsame"), "-old\n+new\n same");
  const big = Array.from({ length: 600 }, (_, i) => "l" + i).join("\n");
  const ops = R.mcRpLineDiff(big, big + "\nx");
  assert.equal(ops.length, 1201, "past the cap: no common-line search");
  assert.ok(ops.slice(0, 600).every((o) => o.op === "-"));
});

test("Replace opens the preview first: loading, then was / will be, with the replace button and Cancel", async () => {
  const c = page({ ok: true, before: "Old line", after: "New line", same: false });
  const button = run(c, "mcReplaceHTML(st.rows[0], 'Replace in Safari', false, " + esc.toString() + ")");
  assert.match(button, /data-replace-ask="7">Replace in Safari</);
  assert.doesNotMatch(button, /data-replace="/, "nothing is pasted from the first press");
  c.ev = click("data-replace-ask", 7);
  assert.equal(run(c, "mcRpClick(ev, {BR, st, repaint})"), true);
  assert.match(run(c, "mcReplaceHTML(st.rows[0], 'Replace in Safari', false, " + esc.toString() + ")"), /Preparing the preview…/);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(c.asked, ["Here is the text:\n\nNew line"], "main makes the text, as the paste will");
  const html = run(c, "mcReplaceHTML(st.rows[0], 'Replace in Safari', false, " + esc.toString() + ")");
  assert.match(html, /<span class="dl dl-del">-Old line<\/span><span class="dl dl-add">\+New line<\/span>/);
  assert.match(html, /Was<\/span><span class="mc-rp-will">Will be/);
  assert.match(html, /<button type="button" class="mc-act mc-replace" data-replace="7">Replace in Safari<\/button>/, "mini-chat.js's own handler pastes");
  assert.match(html, /data-replace-cancel="7">Cancel</);
  assert.ok(c.repaints >= 2);
});

test("Cancel and Esc close it and keep the window; an answer that comes after Cancel is ignored", async () => {
  const c = page({ ok: true, before: "a", after: "b", same: false });
  c.ev = click("data-replace-ask", 7);
  run(c, "mcRpClick(ev, {BR, st, repaint})");
  c.ev = click("data-replace-cancel", 7);
  assert.equal(run(c, "mcRpClick(ev, {BR, st, repaint})"), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(run(c, "MCRP.rowId"), null);
  assert.match(run(c, "mcReplaceHTML(st.rows[0], 'R', false, " + esc.toString() + ")"), /data-replace-ask="7"/);

  c.ev = click("data-replace-ask", 7);
  run(c, "mcRpClick(ev, {BR, st, repaint})");
  await new Promise((r) => setImmediate(r));
  let prevented = false;
  c.key = { key: "Escape", preventDefault: () => { prevented = true; } };
  assert.equal(run(c, "mcRpKey(key, repaint)"), true);
  assert.equal(prevented, true, "the window's own Esc sees defaultPrevented and stays open");
  assert.equal(run(c, "mcRpKey(key, repaint)"), false, "nothing open: Esc is the window's again");
});

test("a refusal shows its line with Cancel only; the same text says nothing would change", async () => {
  const c = page({ ok: false, error: "To put the answer back in the app, install xdotool." });
  c.ev = click("data-replace-ask", 7);
  run(c, "mcRpClick(ev, {BR, st, repaint})");
  await new Promise((r) => setImmediate(r));
  const bad = run(c, "mcReplaceHTML(st.rows[0], 'Replace', false, " + esc.toString() + ")");
  assert.match(bad, /install xdotool/);
  assert.doesNotMatch(bad, /data-replace="/);
  const same = page({ ok: true, before: "x", after: "x", same: true });
  same.ev = click("data-replace-ask", 7);
  run(same, "mcRpClick(ev, {BR, st, repaint})");
  await new Promise((r) => setImmediate(r));
  const html = run(same, "mcReplaceHTML(st.rows[0], 'Replace', false, " + esc.toString() + ")");
  assert.match(html, /The answer is the same as the selected text\./);
  assert.doesNotMatch(html, /data-replace="/);
});

test("main: the preview's text is the paste's text; a blocked app or no answer says why", () => {
  assert.deepEqual(P.replacePreview("Old\r\nline ", null, "Sure! Here is the rewritten text:\n\n```\nNew\nline\n```"),
    { ok: true, before: "Old\nline", after: "New\nline", same: false });
  assert.equal(P.replacePreview("Same", null, '"Same"').same, true);
  assert.deepEqual(P.replacePreview("x", { name: "", pid: 0, blocked: "Install wtype." }, "y"), { ok: false, error: "Install wtype." });
  assert.equal(P.replacePreview("x", null, "   ").ok, false);
  assert.equal(P.replacePreview(null, null, "y").before, "");
  const own = "Here is the updated schedule:\nMon 9am";
  assert.deepEqual(P.replacePreview("Here is the updated schedule:\nMon 9 am", null, own).after, own, "the selection's own first line stays");
});

test("the hooks: the click and Esc go to the preview first, the scripts and styles load in order, main and preload answer", () => {
  const js = read("../renderer/mini-chat.js");
  const clickAt = js.indexOf("if (typeof mcRpClick === 'function' && mcRpClick(e, {BR, st, repaint})) return;");
  assert.ok(clickAt > 0 && clickAt < js.indexOf("e.target.closest('[data-replace]')"));
  assert.match(js, /document\.addEventListener\('keydown', \(e\) => \{ if \(typeof mcRpKey === 'function'\) mcRpKey\(e, repaint\); \}, true\);/);
  const html = read("../renderer/mini-chat.html");
  const order = ["diff-lines.js", "mini-chat-replace-preview.js", "mini-chat-selection.js", "mini-chat.js"].map((f) => html.indexOf('src="' + f + '"'));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), String(order));
  assert.match(html, /href="css\/diff-lines\.css"/);
  assert.match(read("../renderer/css/mini-chat.css"), /\.mc-rp\{/);
  const qw = read("../main/quick-entry-window.ts");
  const h = qw.slice(qw.indexOf('ipcMain.handle("app:quickEntryReplacePreview"'));
  assert.match(h.slice(0, 400), /event\.sender !== box\.webContents/);
  assert.match(h.slice(0, 400), /return replacePreview\(selection, source, raw\);/);
  assert.match(read("../preload/preload.ts"), /quickEntryReplacePreview: \(text: string\) => ipcRenderer\.invoke\("app:quickEntryReplacePreview", text\),/);
});
