// Unit tests for ATO-1063 (the mini window's chat page): main/mini-chat.ts
// (against the built output), the pure part of renderer/mini-chat.js and
// renderer/mini-chat-handoff.js, and the wiring read from the sources.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/mini-chat.js");
const R = require("../renderer/mini-chat.js");
const H = require("../renderer/mini-chat-handoff.js");

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ---------- main: the page, the hand-over, the forwarding ---------- */

test("miniChatPagePath points at the renderer's mini-chat.html beside out/main", () => {
  const p = M.miniChatPagePath("/app/out/main").replace(/\\/g, "/");
  assert.equal(p, "/app/out/renderer/mini-chat.html");
});

test("only a short token is a session id the page may hand over", () => {
  assert.equal(M.miniChatSessionId("ses_01HXYZ-abc.def:1"), "ses_01HXYZ-abc.def:1");
  assert.equal(M.miniChatSessionId("  abc  "), "abc");
  assert.equal(M.miniChatSessionId(""), null);
  assert.equal(M.miniChatSessionId("../etc/passwd"), null);
  assert.equal(M.miniChatSessionId("<img src=x>"), null);
  assert.equal(M.miniChatSessionId("a".repeat(201)), null);
  assert.equal(M.miniChatSessionId(42), null);
  assert.equal(M.miniChatSessionId(null), null);
});

test("the hand-over is taken once", () => {
  const h = new M.MiniChatHandoff();
  assert.equal(h.take(), null);
  h.put("s1");
  h.put("s2");
  assert.equal(h.take(), "s2");
  assert.equal(h.take(), null);
});

test("frames go to every open page, and a page gone away is dropped", () => {
  const v = new M.MiniChatViewers();
  const got = [];
  const page = (name, dead = false) => ({ isDestroyed: () => dead, send: (ch, p) => got.push([name, ch, p]) });
  const a = page("a");
  const gone = page("gone", true);
  const throws = { isDestroyed: () => false, send: () => { throw new Error("closing"); } };
  v.add(a); v.add(gone); v.add(throws);
  v.forward("agent:chat", { turnId: "t" });
  assert.deepEqual(got, [["a", "agent:chat", { turnId: "t" }]]);
  assert.equal(v.size(), 2);
  v.delete(a);
  v.forward("agent:chat", {});
  assert.equal(got.length, 1);
});

test("MINI_CHAT_SIZE is a small window, bigger than the one-line box", () => {
  assert.ok(M.MINI_CHAT_SIZE.width >= 400 && M.MINI_CHAT_SIZE.width <= 640);
  assert.ok(M.MINI_CHAT_SIZE.height >= 400 && M.MINI_CHAT_SIZE.height <= 720);
});

/* ---------- the page: a new chat, streamed ---------- */

const frame = (turnId, kind, extra = {}) => ({ turnId, kind, ...extra });

test("the first message starts a new chat; frames before the turn's id are read once it comes", () => {
  const st = R.mcState();
  assert.equal(R.mcSend(st, "   "), false);
  assert.equal(R.mcSend(st, " hello "), true);
  assert.equal(st.rows[0].text, "hello");
  assert.equal(st.busy, true);
  assert.equal(R.mcSend(st, "again"), false, "one turn at a time");
  // The agent answers faster than BR.chat's own answer comes back.
  R.mcFrame(st, frame("other", "delta", { text: "not ours" }));
  R.mcFrame(st, frame("t1", "session_id", { payload: { sessionId: "s1" } }));
  R.mcFrame(st, frame("t1", "delta", { text: "Hi" }));
  assert.equal(st.reply.text, "");
  R.mcStarted(st, "t1");
  assert.equal(st.sessionId, "s1");
  assert.equal(st.reply.text, "Hi");
  assert.equal(st.early.length, 0);
  assert.equal(R.mcFrame(st, frame("other", "delta", { text: "x" })), false);
  R.mcFrame(st, frame("t1", "delta", { text: " there" }));
  const reply = st.reply;
  R.mcFrame(st, frame("t1", "done"));
  assert.equal(reply.text, "Hi there");
  assert.equal(st.busy, false);
  assert.equal(st.turnId, null);
  assert.equal(st.sessionId, "s1", "the next message goes into the same chat");
});

test("a tool call says what the turn does, and the polished reply replaces only its own step", () => {
  const st = R.mcState();
  R.mcSend(st, "q");
  R.mcStarted(st, "t");
  R.mcFrame(st, frame("t", "delta", { text: "Let me look. " }));
  R.mcFrame(st, frame("t", "tool_progress", { payload: { tool: "web.search" } }));
  assert.equal(st.activity, "Using web.search…");
  R.mcFrame(st, frame("t", "delta", { text: "Hope this helps! Answer" }));
  R.mcFrame(st, frame("t", "reply_polished", { payload: { text: "Answer" } }));
  assert.equal(st.reply.text, "Let me look. Answer");
  assert.equal(R.mcFrame(st, frame("t", "tool_progress", { payload: { tool: "reply" } })), false);
});

test("a step's failure with nothing after it is the turn's; with work after it, it is not", () => {
  const st = R.mcState();
  R.mcSend(st, "q");
  R.mcStarted(st, "t");
  R.mcFrame(st, frame("t", "error", { payload: { message: "out of credit" } }));
  R.mcFrame(st, frame("t", "done"));
  assert.equal(st.rows.at(-1).k, "note");
  assert.equal(st.rows.at(-1).text, "out of credit");
  assert.ok(!st.rows.some((r) => r.k === "assistant"));

  const st2 = R.mcState();
  R.mcSend(st2, "q");
  R.mcStarted(st2, "t");
  R.mcFrame(st2, frame("t", "error", { payload: { message: "step failed" } }));
  R.mcFrame(st2, frame("t", "delta", { text: "(paused)" }));
  R.mcFrame(st2, frame("t", "done"));
  assert.equal(st2.rows.at(-1).text, "(paused)");
});

test("Stop and a failed start end the turn and say so", () => {
  const st = R.mcState();
  R.mcSend(st, "q");
  R.mcStarted(st, "t");
  R.mcFrame(st, frame("t", "aborted"));
  assert.equal(st.busy, false);
  assert.equal(st.rows.at(-1).text, "Stopped.");

  const st2 = R.mcState();
  R.mcSend(st2, "q");
  R.mcStartFailed(st2, "the agent is not running");
  assert.equal(st2.busy, false);
  assert.match(st2.rows.at(-1).text, /the agent is not running/);
  assert.ok(!st2.rows.some((r) => r.k === "assistant"), "the empty reply row goes");
});

test("frames kept before the turn's id are capped", () => {
  const st = R.mcState();
  R.mcSend(st, "q");
  for (let i = 0; i < R.MC_EARLY_MAX + 50; i++) R.mcFrame(st, frame("busy-elsewhere", "delta", { text: "x" }));
  assert.equal(st.early.length, R.MC_EARLY_MAX);
});

/* ---------- approvals: sent to the big window ---------- */

test("a request of this chat shows one line pointing at the big window; others do not", () => {
  const st = R.mcState();
  R.mcSend(st, "q");
  R.mcStarted(st, "t");
  R.mcFrame(st, frame("t", "session_id", { payload: { session_id: "s1" } }));
  assert.equal(R.mcApproval(st, { approvalId: "a0", sessionId: "s2", tool: "fs.write" }), false);
  assert.equal(R.mcApproval(st, { approvalId: "a1", sessionId: "s1", tool: "shell.run" }), true);
  assert.equal(st.approval.tool, "shell.run");
  assert.match(R.mcApprovalLine(st.approval), /big window/);
  // The call goes on (answered in the big window): the line goes.
  R.mcFrame(st, frame("t", "tool_result", { payload: {} }));
  assert.equal(st.approval, null);
});

test("a request that came before the turn named its chat is shown once it does", () => {
  const st = R.mcState();
  R.mcSend(st, "q");
  R.mcStarted(st, "t");
  assert.equal(R.mcApproval(st, { approvalId: "a1", sessionId: "s1", tool: "shell.run" }), false);
  R.mcFrame(st, frame("t", "session_id", { payload: { sessionId: "s1" } }));
  assert.equal(st.approval && st.approval.tool, "shell.run");
});

test("the page has no way to answer a request", () => {
  const js = src("../renderer/mini-chat.js");
  assert.ok(!/\.approve\(/.test(js), "mini-chat.js never calls BR.approve");
});

/* ---------- markup ---------- */

test("what the person typed and a reply without md-render are escaped", () => {
  const st = R.mcState();
  R.mcSend(st, "<b>hi</b>");
  const html = R.mcRowsHTML(st);
  assert.ok(html.includes("&lt;b&gt;hi&lt;/b&gt;"));
  assert.ok(!html.includes("<b>hi</b>"));
  assert.equal(R.mcReplyHTML("<script>x</script>"), "&lt;script&gt;x&lt;/script&gt;");
});

/* ---------- the main window's side ---------- */

test("mini:take's answer is read as a session id or nothing", () => {
  assert.equal(H.mchoTarget({ sessionId: "s1" }), "s1");
  assert.equal(H.mchoTarget({ sessionId: "../x" }), null);
  assert.equal(H.mchoTarget(null), null);
});

test("the main window takes the live turns over before it opens the chat, then replays approvals", async () => {
  const order = [];
  const ok = await H.mchoOpen("s1", {
    liveTurns: async () => { order.push("liveTurns"); return [{ turnId: "t" }]; },
    adopt: (list) => order.push("adopt:" + list.length),
    open: async (id) => order.push("open:" + id),
    replay: async () => order.push("replay"),
    refresh: async () => order.push("refresh"),
  });
  assert.equal(ok, true);
  assert.deepEqual(order, ["liveTurns", "adopt:1", "open:s1", "replay", "refresh"]);
});

test("a failed live-turn read still opens the chat; a failed open says so", async () => {
  const order = [];
  assert.equal(await H.mchoOpen("s1", { liveTurns: async () => { throw new Error("x"); }, adopt: () => {}, open: async () => order.push("open") }), true);
  assert.deepEqual(order, ["open"]);
  assert.equal(await H.mchoOpen("s1", { open: async () => { throw new Error("x"); } }), false);
  assert.equal(await H.mchoOpen(null, { open: async () => {} }), false);
});

/* ---------- the main window: an approval of a mini chat (review fix 1) ---------- */

test("main window on chat A, approval for the mini chat: not drawn in A, kept for the mini chat", () => {
  const known = new Map();
  // Before main says which chat the mini window started, nothing keeps it: drawn where the person is.
  assert.equal(H.mchoApprovalPlace("mini-1", "chat-A", false, known), "here");
  assert.equal(H.mchoNote(known, { sessionId: "mini-1", title: "what is on my calendar" }), "mini-1");
  assert.equal(H.mchoApprovalPlace("mini-1", "chat-A", false, known), "kept");
  // Opened (the mini chat is the one on screen): drawn there.
  assert.equal(H.mchoApprovalPlace("mini-1", "mini-1", false, known), "here");
  // Others as before: a reachable chat is kept, an unknown one with no row is drawn here.
  assert.equal(H.mchoApprovalPlace("chat-B", "chat-A", true, known), "kept");
  assert.equal(H.mchoApprovalPlace("stray", "chat-A", false, known), "here");
});

test("main's word about a mini chat is read as a session id, newest kept", () => {
  const known = new Map();
  assert.equal(H.mchoNote(known, { sessionId: "../x" }), null);
  assert.equal(H.mchoNote(known, null), null);
  assert.equal(known.size, 0);
  for (let i = 0; i < H.MCHO_KNOWN_MAX + 5; i++) H.mchoNote(known, { sessionId: "s" + i });
  assert.equal(known.size, H.MCHO_KNOWN_MAX);
  assert.ok(!known.has("s0") && known.has("s" + (H.MCHO_KNOWN_MAX + 4)));
});

test("main keeps the mini chats once each, for the main window's page", () => {
  const s = new M.MiniChatSessions();
  assert.deepEqual(s.add("s1", "  hello \n there "), { sessionId: "s1", title: "hello there" });
  assert.equal(s.add("s1", "again"), null, "told once");
  assert.equal(s.add("<x>", "bad"), null);
  assert.deepEqual(s.list(), [{ sessionId: "s1", title: "hello there" }]);
  for (let i = 0; i < M.MINI_CHAT_SESSIONS_MAX + 3; i++) s.add("n" + i, "");
  assert.equal(s.list().length, M.MINI_CHAT_SESSIONS_MAX);
});

test("the page names its chat to main once, with its first message", () => {
  const st = R.mcState();
  R.mcSend(st, "first question");
  assert.equal(R.mcTitle(st), "first question");
  const page = src("../renderer/mini-chat.js");
  assert.match(page, /BR\.miniChatSession\(told = st\.sessionId, mcTitle\(st\)\)/);
  assert.match(page, /told !== st\.sessionId/);
});

test("approvalReachable asks the hand-over about mini chats; the hand-over listens to main", () => {
  const r = src("../renderer/renderer.js");
  const body = r.slice(r.indexOf("function approvalReachable(sid)"), r.indexOf("function sessionsRead()"));
  assert.match(body, /typeof mchoKnows === 'function' && mchoKnows\(sid\)\) return true;/);
  const h = src("../renderer/mini-chat-handoff.js");
  assert.match(h, /onMiniChatSession\(/);
  assert.match(h, /miniChatSessions\(\)/);
  const preload = src("../preload/preload.ts");
  for (const ch of ["mini:session", "mini:sessions", "mini:sessionKnown"]) assert.ok(preload.includes(`"${ch}"`), ch);
  const ipc = src("../main/mini-chat-ipc.ts");
  for (const ch of ["mini:session", "mini:sessions", "mini:sessionKnown"]) assert.ok(ipc.includes(`"${ch}"`), ch);
});

/* ---------- the mini window stays up on blur (review fix 2) ---------- */

test("attach drops the window's blur listeners and keeps the rest; Esc still closes it", async () => {
  const { EventEmitter } = await import("node:events");
  const win = new EventEmitter();
  let hidden = 0, closed = 0, relayed = 0;
  win.on("blur", () => { hidden++; });          // the host window's "put away on blur"
  win.on("closed", () => { closed++; });
  M.miniChatKeepOnBlur(win, () => { relayed++; });
  win.emit("blur");
  assert.equal(hidden, 0, "losing focus does not put the chat away");
  assert.equal(relayed, 1, "Electron's own blur relay is put back");
  win.emit("closed");
  assert.equal(closed, 1, "closing still runs the host's own handler");
  M.miniChatKeepOnBlur(win);
  assert.equal(win.listenerCount("blur"), 0);
  // Wiring: attach does it, for the mini window only; Esc in the page closes the window.
  const ipc = src("../main/mini-chat-ipc.ts");
  const attach = ipc.slice(ipc.indexOf('"mini:attach"'), ipc.indexOf('"mini:openInMain"'));
  assert.ok(attach.indexOf("if (isMain(wc)) return") < attach.indexOf("miniChatKeepOnBlur("), "never the main window");
  assert.match(attach, /BrowserWindow\.fromWebContents\(wc\)/);
  assert.match(src("../renderer/mini-chat.js"), /e\.key === 'Escape' && !e\.defaultPrevented\) window\.close\(\)/);
});

/* ---------- wiring, read from the sources ---------- */

test("main wires the routes, the preload exposes them, the main window loads the hand-over after renderer.js", () => {
  const main = src("../main/main.ts");
  assert.match(main, /import \{ wireMiniChatIpc \} from "\.\/mini-chat-ipc\.js";/);
  assert.match(main, /wireMiniChatIpc\(client, \{ mainWindow: \(\) => win, showMainWindow: /);
  const preload = src("../preload/preload.ts");
  for (const ch of ["mini:attach", "mini:openInMain", "mini:take", "mini:openSession"]) assert.ok(preload.includes(`"${ch}"`), ch);
  const ipc = src("../main/mini-chat-ipc.ts");
  for (const ch of ["mini:attach", "mini:openInMain", "mini:take", "mini:openSession", "agent:chat", "agent:approval"]) assert.ok(ipc.includes(`"${ch}"`), ch);
  const index = src("../renderer/index.html");
  const at = (s) => index.indexOf(s);
  assert.ok(at('<script src="renderer.js">') > 0);
  assert.ok(at('<script src="mini-chat-handoff.js">') > at('<script src="renderer.js">'));
});

test("the mini page loads the markdown renderer before its own script, under the window's CSP", () => {
  const html = src("../renderer/mini-chat.html");
  assert.match(html, /script-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  const at = (s) => html.indexOf(s);
  for (const s of ["vendor/marked.js", "vendor/purify.js", "md-render.js"]) assert.ok(at(s) > 0 && at(s) < at('<script src="mini-chat.js">'), s);
  assert.ok(!html.includes("renderer.js"), "the whole renderer is not loaded");
  for (const id of ["mc-log", "mc-input", "mc-send", "mc-open", "mc-wait", "mc-wait-text"]) assert.ok(html.includes(`id="${id}"`), id);
});
