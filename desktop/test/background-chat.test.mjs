// ATO-2309: a background chat from the ⌘K palette (renderer/background-chat.js)
// and the hooks that wire it into renderer.js and index.html.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const BG = require("../renderer/background-chat.js");
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the text: trimmed and capped; nothing for blank", () => {
  assert.equal(BG.bgChatText("  fix the login  "), "fix the login");
  assert.equal(BG.bgChatText("   "), null);
  assert.equal(BG.bgChatText(undefined), null);
  assert.equal(BG.bgChatText("x".repeat(20005)).length, 20000);
});

test("the palette row: only with a query and other results; the empty state has its own button", () => {
  assert.equal(BG.bgChatPaletteRow("", 3), null);
  assert.equal(BG.bgChatPaletteRow("deploy", 0), null);
  const row = BG.bgChatPaletteRow(" deploy ", 2);
  assert.equal(row.act, "bgchat:");
  assert.equal(row.badge, "bg");
  assert.equal(row.sc, "⌘↩");
  assert.match(row.t, /New background chat: “deploy”/);
  assert.equal(BG.bgChatEmptyRowHTML("  "), "");
  assert.match(BG.bgChatEmptyRowHTML("deploy"), /data-act="bgchat:".*New background chat: &ldquo;deploy&rdquo;/);
});

test("the end toast: none while the chat is on screen, red for a failure", () => {
  assert.equal(BG.bgChatEndToast("done", "T", true), null);
  assert.equal(BG.bgChatEndToast("done", "T", false).t, "Background chat finished");
  assert.equal(BG.bgChatEndToast("aborted", "T", false).t, "Background chat stopped");
  const bad = BG.bgChatEndToast("error", "T", false);
  assert.equal(bad.t, "Background chat failed");
  assert.equal(bad.kind, "bad");
});

/* The renderer half, in one context with the globals it reads at call time. */
function load(chatAnswer) {
  const ctx = {
    console, setTimeout: () => 0, document: undefined, window: undefined,
    toasts: [], acts: [], adopted: [], rendered: 0, chats: [],
    LIVE_TURNS: new Map(),
    S: { sessionId: "here", room: "chat", overlay: "palette", q: "  write the release notes " },
  };
  ctx.toast = (t, s, kind) => ctx.toasts.push({ t, s, kind });
  ctx.act = (a) => { ctx.acts.push(a); if (a === "close") { ctx.S.overlay = null; ctx.S.q = ""; } };
  ctx.render = () => { ctx.rendered++; };
  ctx.renderSidebar = () => {};
  ctx.chatTitle = (t) => t.slice(0, 72);
  ctx.reasoningTurnLevel = () => undefined;
  ctx.projectTurnModel = () => null;
  ctx.openSession = (id) => { throw new Error("must not switch chats: " + id); };
  ctx.adoptLiveTurns = (list) => {
    ctx.adopted.push(...list);
    for (const t of list) ctx.LIVE_TURNS.set(t.turnId, { log: [{ k: "user" }, { k: "system", text: "old" }] });
  };
  ctx.BR = { chat: async (...args) => { ctx.chats.push(args); return chatAnswer; } };
  vm.createContext(ctx);
  vm.runInContext(read("../renderer/background-chat.js"), ctx, { filename: "background-chat.js" });
  return ctx;
}

test("⌘↩: closes the palette, starts a NEW chat with the text, takes it over in the background, stays here", async () => {
  const c = load({ ok: true, turnId: "t-9" });
  assert.equal(vm.runInContext("bgChatFromPalette()", c), true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(c.acts, ["close"]);
  assert.equal(c.chats.length, 1);
  const [messages, session, project] = c.chats[0];
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ role: "user", content: "write the release notes" }]);
  assert.equal(session, undefined, "a new chat, not the one on screen");
  assert.equal(project, undefined);
  assert.equal(c.adopted[0].turnId, "t-9");
  assert.equal(c.adopted[0].sessionId, null);
  assert.equal(c.adopted[0].firstTurn, true, "its row joins the list once the stream names its session");
  assert.equal(c.LIVE_TURNS.get("t-9").log[1].text, BG.BGCHAT_LINE);
  assert.equal(c.S.sessionId, "here", "the person stays in their chat");
  assert.match(c.toasts.at(-1).t, /Background chat started/);
});

test("its end: a toast while elsewhere, none when the person is looking at it, other turns ignored", async () => {
  const c = load({ ok: true, turnId: "t-9" });
  vm.runInContext("bgChatFromPalette()", c);
  await new Promise((r) => setImmediate(r));
  const before = c.toasts.length;
  vm.runInContext("bgChatTurnEnded('t-other', 'x', 'done')", c);
  assert.equal(c.toasts.length, before, "not a background chat");
  vm.runInContext("bgChatTurnEnded('t-9', 'bg-sid', 'done')", c);
  assert.equal(c.toasts.at(-1).t, "Background chat finished");
  assert.match(c.toasts.at(-1).s, /write the release notes/);
  vm.runInContext("bgChatTurnEnded('t-9', 'bg-sid', 'done')", c);
  assert.equal(c.toasts.length, before + 1, "once");

  const d = load({ ok: true, turnId: "t-1" });
  vm.runInContext("bgChatFromPalette()", d);
  await new Promise((r) => setImmediate(r));
  d.S.sessionId = "bg-sid";
  const n = d.toasts.length;
  vm.runInContext("bgChatTurnEnded('t-1', 'bg-sid', 'error')", d);
  assert.equal(d.toasts.length, n, "the chat is on screen");
});

test("a refused start keeps the task in the palette, says why in words and offers Retry; an empty query does nothing", async () => {
  const c = load({ ok: false, error: "no model" });
  vm.runInContext("bgChatFromPalette()", c);
  await new Promise((r) => setImmediate(r));
  assert.equal(c.adopted.length, 0);
  assert.equal(c.S.overlay, "palette", "the palette stays open");
  assert.equal(c.S.q, "  write the release notes ", "the typed task is kept");
  assert.deepEqual(c.acts, [], "nothing closed it");
  const row = vm.runInContext("bgChatPaletteRow(S.q, 2)", c);
  assert.match(row.t, /^Retry background chat: “write the release notes”/);
  assert.match(row.cx, /No model is ready/);
  assert.doesNotMatch(row.cx, /unknown error|no model$/);
  assert.match(vm.runInContext("bgChatEmptyRowHTML(S.q)", c), /Retry background chat.*No model is ready/);
  // Retry is the same ⌘↩: it asks again.
  vm.runInContext("bgChatFromPalette()", c);
  await new Promise((r) => setImmediate(r));
  assert.equal(c.chats.length, 2);

  const e = load({ ok: true, turnId: "t-2" });
  e.S.q = "   ";
  assert.equal(vm.runInContext("bgChatFromPalette()", e), false);
  assert.equal(e.chats.length, 0);
  assert.equal(e.S.overlay, "palette");
});

test("a failure after the palette was closed brings it back with the task; the raw IPC text is never shown", async () => {
  const c = load(null);
  c.BR.chat = async () => { c.act("close"); throw new Error("Error invoking remote method 'agent:chat': Error: agent not running"); };
  vm.runInContext("bgChatFromPalette()", c);
  await new Promise((r) => setImmediate(r));
  assert.equal(c.S.overlay, "palette");
  assert.equal(c.S.q, "write the release notes");
  const row = vm.runInContext("bgChatPaletteRow(S.q, 1)", c);
  assert.match(row.cx, /The agent is not running right now/);
  assert.doesNotMatch(JSON.stringify(c.toasts) + row.cx, /Error invoking remote method/);
  assert.equal(BG.bgChatErrorLine("something odd"), "Something went wrong while starting it. Try again.");
});

test("a second ⌘↩ while it starts says so and starts nothing more", async () => {
  const c = load(null);
  let release;
  c.BR.chat = (...args) => { c.chats.push(args); return new Promise((r) => { release = r; }); };
  vm.runInContext("bgChatFromPalette()", c);
  assert.match(vm.runInContext("bgChatPaletteRow(S.q, 1)", c).t, /^Starting a background chat/);
  vm.runInContext("bgChatFromPalette()", c);
  assert.equal(c.chats.length, 1);
  assert.equal(c.toasts.at(-1).t, "Still starting the background chat");
  assert.equal(c.toasts.at(-1).kind, "info");
  release({ ok: true, turnId: "t-3" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(c.acts, ["close"]);
});

test("renderer.js hooks: palette row, empty state, header, act, ⌘↩, turn end; index.html loads it first", () => {
  const src = read("../renderer/renderer.js");
  const rows = src.slice(src.indexOf("\nfunction palRows("), src.indexOf("\nconst PALMSG"));
  assert.match(rows, /bgChatPaletteRow\(S\.q, hits\.length\) : null; if \(bg\) hits\.push\(bg\); \}[^\n]*\n\s*return hits;/);
  const pal = src.slice(src.indexOf("\nfunction paletteHTML("), src.indexOf("\n/* ---------------- slash completion"));
  assert.match(pal, /\(typeof bgChatEmptyRowHTML === 'function' \? bgChatEmptyRowHTML\(q\) : ''\) \+ '<\/div>';/);
  assert.match(pal, /message:'In chat messages', bg:'Background'\}/);
  assert.match(src, /if \(k === 'bgchat'\) \{ if \(typeof bgChatFromPalette === 'function'\) bgChatFromPalette\(\); return; \}/);
  assert.match(src, /if \(mod && !e\.shiftKey && !e\.altKey && k === 'Enter' && S\.overlay === 'palette' && !S\.scope && typeof bgChatFromPalette === 'function'\) \{ e\.preventDefault\(\); APPR_CHORD_AT = Date\.now\(\);[^\n]*bgChatFromPalette\(\); return; \}/);
  // ⌘↩ in the palette is taken before the palette's own keys and before the generic ⌘↩ (Send, which does nothing over a layer).
  const hook = src.indexOf("S.overlay === 'palette' && !S.scope && typeof bgChatFromPalette");
  assert.ok(hook > 0 && hook < src.indexOf("if (sk === 'Enter') { e.preventDefault(); if (!layerOverChat()) submit(); return; }"));
  const end = src.slice(src.indexOf("if (ev.kind === 'done' || ev.kind === 'aborted' || ev.kind === 'error') {\n      const sid = RUNNING.get(ev.turnId);"));
  assert.match(end.slice(0, 1400), /workerTurnEnded\(sid, ev\.kind\);[^\n]*\n\s*if \(typeof bgChatTurnEnded === 'function'\) bgChatTurnEnded\(ev\.turnId, sid, ev\.kind\);/);
  const html = read("../renderer/index.html");
  const at = html.indexOf('src="background-chat.js"');
  assert.ok(at > 0 && at < html.indexOf('src="renderer.js"'));
});

/* ATO-2478: from the quick entry window, and "Open" on the end toast. */
test("from the quick entry window: a new chat with its own line; the chat on screen stays", async () => {
  const c = load({ ok: true, turnId: "t-q" });
  c.S.overlay = null;
  assert.equal(await vm.runInContext("bgChatFromQuickEntry('  tidy the README ')", c), true);
  const [messages, session] = c.chats[0];
  assert.equal(messages[0].content, "tidy the README");
  assert.equal(session, undefined);
  assert.equal(c.LIVE_TURNS.get("t-q").log[1].text, BG.BGCHAT_QUICK_LINE);
  assert.equal(c.S.sessionId, "here");
  assert.deepEqual(c.acts, [], "no palette to close, nothing opened");
  assert.equal(await vm.runInContext("bgChatFromQuickEntry('   ')", c), false);
  assert.equal(c.chats.length, 1);
});

test("the end toast has Open, which goes to that chat; no session, no button", async () => {
  const c = load({ ok: true, turnId: "t-9" });
  c.withAction = [];
  c.toastWithAction = (t, s, kind, action) => c.withAction.push({ t, s, kind, action });
  vm.runInContext("bgChatFromPalette()", c);
  await new Promise((r) => setImmediate(r));
  const plain = c.toasts.length;
  vm.runInContext("bgChatTurnEnded('t-9', 'bg-sid', 'done')", c);
  assert.equal(c.toasts.length, plain, "raised with its button instead");
  assert.equal(c.withAction.length, 1);
  assert.equal(c.withAction[0].t, "Background chat finished");
  assert.equal(c.withAction[0].action.label, "Open");
  c.acts.length = 0;
  c.withAction[0].action.run();
  assert.deepEqual(c.acts, ["ses:bg-sid"]);

  const d = load({ ok: true, turnId: "t-2" });
  d.withAction = [];
  d.toastWithAction = (...a) => d.withAction.push(a);
  vm.runInContext("bgChatFromPalette()", d);
  await new Promise((r) => setImmediate(r));
  vm.runInContext("bgChatTurnEnded('t-2', null, 'error')", d);
  assert.equal(d.withAction.length, 0);
  assert.equal(d.toasts.at(-1).t, "Background chat failed");
});

test("ATO-2751: a failed start from the quick entry window keeps the task in the palette and says so in a toast", async () => {
  const c = load({ ok: false, error: "agent not running" });
  c.S.overlay = null; c.S.q = "";
  assert.equal(await vm.runInContext("bgChatFromQuickEntry('tidy the README')", c), false);
  assert.equal(c.S.overlay, "palette");
  assert.equal(c.S.q, "tidy the README");
  assert.equal(c.toasts.at(-1).t, "Couldn’t start the background chat");
  assert.match(c.toasts.at(-1).s, /The agent is not running right now/);
  assert.equal(c.toasts.at(-1).kind, "bad");
});
