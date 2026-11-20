// Unit tests for ATO-561's first slice ("Open in new window" on a chat row):
// main/chat-popout.ts (against the built output), the stored-chat part of
// renderer/mini-chat.js, renderer/chat-popout.js, the row menu item, and
// the wiring read from the sources.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const W = require("../out/main/chat-popout.js");
const R = require("../renderer/mini-chat.js");
const O = require("../renderer/chat-popout.js");
const { chatMenuItems } = require("../renderer/chat-list.js");

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ---------- main: ids, one window per chat, the window's options ---------- */

test("only a short token is a chat id that gets a window", () => {
  assert.equal(W.chatPopoutSessionId("ses_01HXYZ-abc.def:1"), "ses_01HXYZ-abc.def:1");
  assert.equal(W.chatPopoutSessionId("hermes:20260511_162944_79a9e8"), "hermes:20260511_162944_79a9e8");
  assert.equal(W.chatPopoutSessionId("  abc  "), "abc");
  for (const bad of ["", "   ", "../etc/passwd", "<img src=x>", "a b", "a".repeat(201), 42, null, undefined, {}]) {
    assert.equal(W.chatPopoutSessionId(bad), null, String(bad));
  }
});

const win = () => {
  let dead = false;
  return { isDestroyed: () => dead, destroy() { dead = true; } };
};

test("one window per chat: a second open finds the first, a closed one frees the chat", () => {
  const m = new W.ChatPopouts();
  const a = win();
  const b = win();
  assert.equal(m.get("s1"), null);
  assert.equal(m.set("s1", a), true);
  assert.equal(m.set("s1", b), false, "the chat already has a window");
  assert.equal(m.get("s1"), a);
  assert.equal(m.has(a), true);
  assert.equal(m.has(b), false);
  assert.equal(m.set("s2", b), true);
  assert.equal(m.size(), 2);
  assert.equal(m.sessionOf((w) => w === b), "s2");
  assert.equal(m.sessionOf(() => false), null);
  m.deleteWindow(a);
  assert.equal(m.get("s1"), null);
  assert.equal(m.has(a), false);
  assert.equal(m.size(), 1);
});

test("a destroyed window is not the chat's any more", () => {
  const m = new W.ChatPopouts();
  const a = win();
  m.set("s1", a);
  a.destroy();
  assert.equal(m.get("s1"), null);
  assert.equal(m.sessionOf(() => true), null);
  assert.equal(m.size(), 0);
  const b = win();
  assert.equal(m.set("s1", b), true, "the chat can get a new window");
  assert.equal(m.get("s1"), b);
});

test("the chat window is an ordinary window with the main window's webPreferences", () => {
  const o = W.chatPopoutOptions({ preload: "/app/out/preload/preload.js", spellcheck: true });
  assert.equal(o.width, W.CHAT_POPOUT_SIZE.width);
  assert.equal(o.height, W.CHAT_POPOUT_SIZE.height);
  assert.equal(o.minWidth, W.CHAT_POPOUT_SIZE.minWidth);
  assert.equal(o.minHeight, W.CHAT_POPOUT_SIZE.minHeight);
  assert.ok(o.width > 480 && o.height > 560, "bigger than the mini window");
  assert.ok(o.width < 1280 && o.height <= 820, "smaller than the main window");
  assert.equal(o.show, false, "shown once its page is ready");
  for (const k of ["alwaysOnTop", "frame", "type", "skipTaskbar", "resizable", "x", "y"]) assert.ok(!(k in o), k);
  assert.deepEqual(o.webPreferences, {
    preload: "/app/out/preload/preload.js",
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webviewTag: false,
    spellcheck: true,
  });
  assert.equal(W.chatPopoutOptions({ preload: "p", spellcheck: false }).webPreferences.spellcheck, false);
});

test("a chat window opens a little off the window it was opened from", () => {
  const o = W.chatPopoutOptions({ preload: "p", spellcheck: true, near: { x: 100, y: 50, width: 1280, height: 820 } });
  assert.equal(o.x, 100 + W.CHAT_POPOUT_OFFSET);
  assert.equal(o.y, 50 + W.CHAT_POPOUT_OFFSET);
  const odd = W.chatPopoutOptions({ preload: "p", spellcheck: true, near: { x: NaN, y: 0, width: 1, height: 1 } });
  assert.ok(!("x" in odd) && !("y" in odd), "no position from bad bounds");
  assert.ok(!("x" in W.chatPopoutOptions({ preload: "p", spellcheck: true, near: null })));
});

test("a chat whose reply is being written is not popped out", () => {
  assert.equal(W.chatPopoutOpenRefusal("s1", ["s2", null, "s1"]), W.CHAT_POPOUT_LIVE_LINE);
  assert.equal(W.chatPopoutOpenRefusal("s1", [null, "s2"]), null);
  assert.equal(W.chatPopoutOpenRefusal("s1", []), null);
  assert.equal(W.CHAT_POPOUT_LIVE_LINE, O.CWO_LIVE_LINE, "the main window says it in the same words");
});

test("a chat with its own window takes turns from that window only", () => {
  assert.equal(W.chatPopoutTurnRefusal(false, false), null, "no window: anyone");
  assert.equal(W.chatPopoutTurnRefusal(true, true), null, "its own window");
  assert.equal(W.chatPopoutTurnRefusal(true, false), W.CHAT_POPOUT_OWNED_LINE, "the main window");
});

/* ---------- the page: a stored chat in its own window ---------- */

test("the page knows it is a chat's own window from main's query", () => {
  const q = "?" + new URLSearchParams(W.CHAT_POPOUT_QUERY).toString();
  assert.equal(R.mcPopout(q), true);
  assert.equal(R.mcPopout("?a=1&window=chat"), true);
  assert.equal(R.mcPopout(""), false);
  assert.equal(R.mcPopout("?window=chatty"), false);
  assert.equal(R.mcPopout(undefined), false);
});

test("a stored chat's messages become rows, a run of tool calls one line", () => {
  const st = R.mcState();
  st.loading = true;
  assert.equal(R.mcSend(st, "too early"), false, "nothing is sent before the chat is in");
  assert.match(R.mcRowsHTML(st), /Loading the chat/);
  const ok = R.mcHistory(st, "s1", {
    title: "  Trip plan  ",
    turns: [
      { kind: "user", text: "plan a trip" },
      { kind: "assistant_tool_call", tool: "web.search", args: {} },
      { kind: "tool_result", status: "ok" },
      { kind: "assistant_tool_call", tool: "web.fetch", args: {} },
      { kind: "assistant_reply", text: "working on it", progressNote: true },
      { kind: "assistant_reply", text: "Here is the plan." },
      { kind: "user", text: "shorter" },
      { kind: "assistant_reply", text: "x", stopped: true },
      null,
      { kind: "user" },
    ],
  });
  assert.equal(ok, true);
  assert.equal(st.loading, false);
  assert.equal(st.sessionId, "s1");
  assert.equal(R.mcTitle(st), "Trip plan");
  assert.deepEqual(st.rows.map((r) => [r.k, r.text]), [
    ["user", "plan a trip"],
    ["note", "Used 2 tools."],
    ["assistant", "Here is the plan."],
    ["user", "shorter"],
    ["assistant", "(stopped)"],
  ]);
  assert.equal(new Set(st.rows.map((r) => r.id)).size, st.rows.length, "row ids are unique");
  // The next message continues that chat.
  assert.equal(R.mcSend(st, "and the budget?"), true);
  assert.equal(st.sessionId, "s1");
});

test("a long chat keeps its newest rows and says the rest are in the main window", () => {
  const st = R.mcState();
  const turns = [];
  for (let i = 0; i < R.MC_HISTORY_MAX + 10; i++) turns.push({ kind: "user", text: "q" + i });
  R.mcHistory(st, "s1", { turns });
  assert.equal(st.rows.length, R.MC_HISTORY_MAX + 1);
  assert.equal(st.rows[0].k, "note");
  assert.match(st.rows[0].text, /main window/);
  assert.equal(st.rows[st.rows.length - 1].text, "q" + (R.MC_HISTORY_MAX + 9));
});

test("a stored chat with nothing in it, or that did not load, still continues that chat", () => {
  const st = R.mcState();
  R.mcHistory(st, "s1", null);
  assert.equal(st.sessionId, "s1");
  assert.deepEqual(st.rows, []);
  assert.match(R.mcRowsHTML(st), /No messages in this chat yet/);
  assert.match(R.mcRowsHTML(R.mcState()), /This starts a new chat/, "the mini window's own line is unchanged");
  assert.equal(R.mcHistory(R.mcState(), null, {}), false);
});

test("a chat window that lost its chat sends nothing", () => {
  const st = R.mcState();
  st.locked = true;
  assert.equal(R.mcSend(st, "hello"), false);
});

/* ---------- the main window: the row's item ---------- */

test("the row menu offers Open in new window for a stored chat only", () => {
  assert.ok(!chatMenuItems({}).some((i) => i.verb === "popout"));
  const items = chatMenuItems({ folders: true, exportable: true, windowable: true });
  assert.deepEqual(items.map((i) => i.verb), ["pin", "unread", "rename", "fpick", "export", "popout", "houtopen", "share", "recipe:save", "delask"]);
  const it = items.find((i) => i.verb === "popout");
  assert.equal(it.label, "Open in new window");
  assert.ok(!it.danger);
});

test("a turn this window streams keeps its chat here", () => {
  const running = new Map([["t1", "s1"], ["t2", null]]);
  assert.equal(O.cwoStreamsHere(running, "s1"), true);
  assert.equal(O.cwoStreamsHere(running, "s2"), false);
  assert.equal(O.cwoStreamsHere(running, ""), false);
  assert.equal(O.cwoStreamsHere(null, "s1"), false);
});

test("main's answer: nothing to say when it opened or focused, its words when it refused", () => {
  assert.equal(O.cwoAnswerToast({ ok: true, focused: true }), null);
  assert.equal(O.cwoAnswerToast({ ok: true, focused: false }), null);
  assert.deepEqual(O.cwoAnswerToast({ ok: false, error: "nope" }), { title: "Could not open the chat in a new window", sub: "nope" });
  assert.equal(O.cwoAnswerToast(null).sub, "");
});

/* ---------- wiring, read from the sources ---------- */

test("main wires the routes, guards agent:chat before a turn starts, and the Dock reopens the main window", () => {
  const main = src("../main/main.ts");
  assert.match(main, /import \{ chatPopoutTurnRefused, isChatPopout, wireChatPopoutIpc \} from "\.\/chat-popout-ipc\.js";/);
  assert.match(main, /wireChatPopoutIpc\(\{ mainWindow: \(\) => win, liveSessionIds: /);
  const chat = main.slice(main.indexOf('ipcMain.handle("agent:chat"'), main.indexOf("async function startTurn("));
  const guard = chat.indexOf("chatPopoutTurnRefused(sessionId, _event.sender)");
  assert.ok(guard > 0, "agent:chat asks");
  assert.ok(guard < chat.indexOf("holdForStudio(") && guard < chat.indexOf("return startTurn("), "before the turn is held or started");
  assert.match(main, /!isQuickEntryWindow\(w\) && !isChatPopout\(w\)/);
  const ipc = src("../main/chat-popout-ipc.ts");
  for (const ch of ["chatPopout:open", "chatPopout:mine"]) assert.ok(ipc.includes(`"${ch}"`), ch);
  assert.match(ipc, /if \(!isMain\(event\.sender\)\) return/, "only the main window opens one");
  assert.match(ipc, /miniChatPagePath\(__dirname\), \{ query: CHAT_POPOUT_QUERY \}/, "the mini page, not index.html");
  assert.ok(!ipc.includes("index.html"));
  assert.ok(ipc.indexOf("windows.get(sessionId)") < ipc.indexOf("chatPopoutOpenRefusal("), "an open window is focused first");
  const preload = src("../preload/preload.ts");
  for (const ch of ["chatPopout:open", "chatPopout:mine"]) assert.ok(preload.includes(`"${ch}"`), ch);
});

test("the main window loads the row's handler after renderer.js, and the menu runs it", () => {
  const index = src("../renderer/index.html");
  const at = (s) => index.indexOf(s);
  assert.ok(at('<script src="chat-popout.js">') > at('<script src="renderer.js">'));
  const r = src("../renderer/renderer.js");
  assert.match(r, /if \(k === 'popout'\)\s+\{ close\(\); render\(\); chatPopoutOpen\(v\); return; \}/);
  assert.match(r, /windowable: stored && typeof chatPopoutCanOffer === 'function' && chatPopoutCanOffer\(\)/);
  assert.match(src("../renderer/analytics-acts.js"), /export:L, popout:L,/);
  const page = src("../renderer/mini-chat.js");
  assert.match(page, /if \(own\) return;/, "Esc does not close a chat's own window");
  assert.match(page, /BR\.session\(sid\)/);
});
