// ATO-2478: the quick entry window's (mini chat's) "run in background":
// renderer/mini-chat-background.js, its hooks in mini-chat.js / mini-chat.html,
// main's app:quickEntryBackground (quick-entry-window.ts, read from the source),
// and the main window's side (quick-entry-settings.js, background-chat.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const B = require("../renderer/mini-chat-background.js");
const { mcComposeWithSelection } = require("../renderer/mini-chat-selection.js");
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const key = (o) => ({ key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: false, ...o });

test("the chord: ⌘↩ on macOS, Ctrl+Enter on Windows and Linux, and it is written that way", () => {
  assert.equal(B.mcBgIsChord(key({ metaKey: true }), "darwin"), true);
  assert.equal(B.mcBgIsChord(key({ ctrlKey: true }), "darwin"), false);
  assert.equal(B.mcBgIsChord(key({ ctrlKey: true }), "win32"), true);
  assert.equal(B.mcBgIsChord(key({ ctrlKey: true }), "linux"), true);
  assert.equal(B.mcBgIsChord(key({ metaKey: true }), "win32"), false, "the Windows key is not Ctrl");
  assert.equal(B.mcBgIsChord(key({}), "win32"), false, "plain Enter sends here");
  assert.equal(B.mcBgIsChord(key({ ctrlKey: true, shiftKey: true }), "win32"), false);
  assert.equal(B.mcBgIsChord(key({ metaKey: true, isComposing: true }), "darwin"), false);
  assert.equal(B.mcBgIsChord(key({ key: "a", metaKey: true }), "darwin"), false);
  assert.equal(B.mcBgChord("darwin"), "⌘↩");
  assert.equal(B.mcBgChord("win32"), "Ctrl+Enter");
  assert.equal(B.mcBgChord("linux"), "Ctrl+Enter");
});

test("the text: what was typed, with the selection quoted under it as Send does", () => {
  assert.equal(B.mcBgText("  fix it  ", null, mcComposeWithSelection), "fix it");
  assert.equal(B.mcBgText("Summarize", "line one\nline two", mcComposeWithSelection), "Summarize\n\n> line one\n> line two");
  assert.equal(B.mcBgText("   ", "sel", mcComposeWithSelection), null);
  assert.equal(B.mcBgText(undefined, null, null), null);
});

test("ready: only the mini window, with no turn of its own running and something typed", () => {
  const st = { busy: false, loading: false, locked: false };
  assert.equal(B.mcBgReady(st, false, "x"), true);
  assert.equal(B.mcBgReady(st, true, "x"), false, "a chat's own window goes on in its chat");
  assert.equal(B.mcBgReady({ ...st, busy: true }, false, "x"), false);
  assert.equal(B.mcBgReady({ ...st, locked: true }, false, "x"), false);
  assert.equal(B.mcBgReady(st, false, "  "), false);
});

/* The wiring, with a tiny fake DOM. */
function wire({ answer, own = false, platform = "win32", selection = null, bridge = true } = {}) {
  const el = (id) => ({ id, hidden: false, disabled: false, title: "", value: "", attrs: {}, on: {},
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.on[k] = f; } });
  const dom = { "mc-bg": el("mc-bg"), "mc-input": el("mc-input") };
  const sent = [], notes = [];
  const BR = { platform };
  if (bridge) BR.quickEntryBackground = async (text) => { sent.push(text); return answer; };
  const st = { busy: false, loading: false, locked: false };
  const bg = B.mcBgWire({ BR, $: (id) => dom[id], st, own, selection: () => selection, note: (t) => notes.push(t) });
  return { bg, dom, sent, notes, st };
}

test("the button: shown in the mini window with the platform's chord, hidden in a chat's own window or without the bridge", () => {
  const w = wire({ platform: "win32" });
  assert.equal(w.dom["mc-bg"].hidden, false);
  assert.match(w.dom["mc-bg"].title, /\(Ctrl\+Enter\)$/);
  assert.match(wire({ platform: "darwin" }).dom["mc-bg"].title, /\(⌘↩\)$/);
  const own = wire({ own: true });
  assert.equal(own.dom["mc-bg"].hidden, true);
  assert.equal(own.bg.usable, false, "a chat's own window keeps ⌘↩ for Send");
  assert.equal(w.bg.usable, true);
  assert.equal(wire({ bridge: false }).dom["mc-bg"].hidden, true);
  w.bg.paint();
  assert.equal(w.dom["mc-bg"].disabled, true, "nothing typed");
  w.dom["mc-input"].value = "go";
  w.bg.paint();
  assert.equal(w.dom["mc-bg"].disabled, false);
});

test("go: hands the text (selection quoted) to main once; a refusal says so in the chat and allows a retry", async () => {
  const w = wire({ answer: { ok: true }, selection: "the paragraph" });
  w.dom["mc-input"].value = "Rewrite this";
  assert.equal(w.bg.go(), true);
  assert.equal(w.bg.go(), false, "not twice while main has it");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.sent, ["Rewrite this\n\n> the paragraph"]);
  assert.equal(w.notes.length, 0);

  const bad = wire({ answer: { ok: false } });
  bad.dom["mc-input"].value = "x";
  bad.bg.go();
  await new Promise((r) => setImmediate(r));
  assert.equal(bad.notes.length, 1);
  assert.match(bad.notes[0], /Could not start a background chat/);
  assert.equal(bad.bg.go(), true, "it can be tried again");

  const busy = wire({ answer: { ok: true } });
  busy.dom["mc-input"].value = "x";
  busy.st.busy = true;
  assert.equal(busy.bg.go(), false);
});

test("mini-chat.js and mini-chat.html: the chord is read before Enter, the button and the script are there", () => {
  const src = read("../renderer/mini-chat.js");
  const kd = src.indexOf("if (bg && bg.usable && mcBgIsChord(e, bg.platform)) { e.preventDefault(); bg.go(); return; }");
  assert.ok(kd > 0 && kd < src.indexOf("if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!st.busy) submit(); }"));
  assert.match(src, /if \(typeof mcBgWire === 'function'\) bg = mcBgWire\(\{BR, \$, st, own, selection: \(\) => selection,/);
  assert.match(src, /send\.disabled = [^\n]*\n\s*if \(bg\) bg\.paint\(\);/);
  const html = read("../renderer/mini-chat.html");
  assert.match(html, /<button id="mc-bg" class="btn btn-s sm" type="button" disabled hidden>Background<\/button>\s*<button id="mc-send"/);
  const at = html.indexOf('src="mini-chat-background.js"');
  assert.ok(at > 0 && at < html.indexOf('src="mini-chat.js"'));
});

test("main: app:quickEntryBackground takes it only from the mini chat, marks it background, does not bring the main window up", () => {
  const src = read("../main/quick-entry-window.ts");
  const h = src.slice(src.indexOf('ipcMain.handle("app:quickEntryBackground"'), src.indexOf('ipcMain.handle("app:quickEntryTake"'));
  assert.match(h, /event\.sender !== box\.webContents\) return \{ ok: false \}/);
  assert.match(h, /pending = text;\n\s*pendingBackground = true;\n\s*hide\(\);/);
  assert.match(h, /const have = w\.mainWindow \? w\.mainWindow\(\) : null;\n\s*const main = have && !have\.isDestroyed\(\) \? have : w\.showMainWindow\(\);/);
  assert.match(h, /if \(!main\.webContents\.isLoading\(\)\) main\.webContents\.send\("app:quickEntry"\);/);
  const take = src.slice(src.indexOf('ipcMain.handle("app:quickEntryTake"'));
  assert.match(take.slice(0, 400), /return text \? \{ text, background \} : null;/);
  const submit = src.slice(src.indexOf('ipcMain.handle("app:quickEntrySubmit"'), src.indexOf('ipcMain.handle("app:quickEntryBackground"'));
  assert.match(submit, /pendingBackground = false;/, "a plain Enter after a background one is not background");
  assert.match(read("../main/main.ts"), /mainWindow: \(\) => win,/);
  assert.match(read("../preload/preload.ts"), /quickEntryBackground: \(text: string\) => ipcRenderer\.invoke\("app:quickEntryBackground", text\),/);
});

test("the main window: a background text goes to bgChatFromQuickEntry, the chat on screen is left alone", async () => {
  const ctx = { console, acts: [], started: [], submitted: 0 };
  ctx.act = (a) => ctx.acts.push(a);
  ctx.submit = () => { ctx.submitted++; };
  ctx.$ = () => null;
  ctx.S = {};
  ctx.bgChatFromQuickEntry = (t) => { ctx.started.push(t); return Promise.resolve(true); };
  ctx.BR = { quickEntryTake: async () => ({ text: " write notes ", background: true }) };
  vm.createContext(ctx);
  vm.runInContext(read("../renderer/quick-entry-settings.js"), ctx, { filename: "quick-entry-settings.js" });
  await vm.runInContext("quickEntryDeliver()", ctx);
  assert.deepEqual(ctx.started, ["write notes"]);
  assert.deepEqual(ctx.acts, [], "no new chat on screen");
  assert.equal(ctx.submitted, 0);
  ctx.BR.quickEntryTake = async () => ({ text: "plain", background: false });
  ctx.autosize = () => {};
  await vm.runInContext("quickEntryDeliver()", ctx);
  assert.deepEqual(ctx.acts, ["session:new"]);
  assert.equal(ctx.submitted, 1);
});
