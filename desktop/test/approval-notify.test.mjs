// ATO-2755: "Atomic Agent needs your OK", a native notification (and the
// phone push) when a chat waits on an approval card. The pure half of main
// (main/approval-notify.ts, from the built output: npm run build first), the
// page's half (renderer/approval-notify.js) and the wiring between them.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/approval-notify.js");
const P = require("../out/main/push-cli.js");
const R = require("../renderer/approval-notify.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/** A notifier with stub deps; `state` is changed by the test as it goes. */
function harness(over = {}) {
  const state = { focused: false, enabled: true, page: true, shown: [], closed: [], ...over };
  const n = new M.ApprovalNotifier({
    isFocused: () => state.focused,
    readEnabled: async () => state.enabled,
    pageAlive: () => state.page,
    chatTitle: async (sid) => (sid === "s1" ? "Fix the login page" : ""),
    show: (note, target) => {
      state.shown.push({ note, target });
      return () => state.closed.push(target.approvalId);
    },
  });
  return { n, state };
}

const card = (extra = {}) => ({
  approvalId: "ap_1", sessionId: "s1", chat: "Fix the login page",
  action: "Allow Atomic Agent to run npm test?", question: false, onScreen: false, ...extra,
});

test("the note: the title asks for an OK, the body is the chat and the card's question", () => {
  const note = M.formatApprovalNote({ chat: "Fix the login page", action: "Allow Atomic Agent to run npm test?", question: false });
  assert.equal(note.title, "Atomic Agent needs your OK");
  assert.equal(note.body, "Fix the login page\nAllow Atomic Agent to run npm test?");
  const q = M.formatApprovalNote({ chat: "", action: "Which database?", question: true });
  assert.equal(q.title, "Atomic Agent has a question");
  assert.equal(q.body, "Which database?");
  // No long dashes anywhere the person reads.
  assert.doesNotMatch(note.title + q.title, /\u2014/);
});

test("one notification per request, however often the stream replays it", async () => {
  const { n, state } = harness();
  assert.equal(await n.fromPage(card()), true);
  assert.equal(await n.fromPage(card()), false);
  assert.equal(await n.fromPage(card({ approvalId: "ap_2" })), true);
  assert.equal(state.shown.length, 2);
  assert.equal(state.shown[0].note.body, "Fix the login page\nAllow Atomic Agent to run npm test?");
  assert.deepEqual(state.shown[0].target, { approvalId: "ap_1", sessionId: "s1" });
});

test("none while the window is focused on that chat; a background chat still rings", async () => {
  const { n, state } = harness({ focused: true });
  assert.equal(await n.fromPage(card({ onScreen: true })), false);
  // Seen at arrival: a replay after the person looked away does not ring late.
  state.focused = false;
  assert.equal(await n.fromPage(card({ onScreen: true })), false);
  state.focused = true;
  assert.equal(await n.fromPage(card({ approvalId: "ap_bg", sessionId: "s2", onScreen: false })), true);
  // The chat on screen, window in the background: rings.
  state.focused = false;
  assert.equal(await n.fromPage(card({ approvalId: "ap_3", onScreen: true })), true);
  assert.deepEqual(state.shown.map((s) => s.target.approvalId), ["ap_bg", "ap_3"]);
});

test("the turn-end switch (tui.notify.enabled) turns it off too", async () => {
  const { n, state } = harness({ enabled: false });
  assert.equal(await n.fromPage(card()), false);
  assert.equal(state.shown.length, 0);
});

test("answered: no late notification, and a shown one closes", async () => {
  const { n, state } = harness();
  n.answered("ap_early");
  assert.equal(await n.fromPage(card({ approvalId: "ap_early" })), false);
  await n.fromPage(card());
  n.answered("ap_1");
  assert.deepEqual(state.closed, ["ap_1"]);
  n.answered("ap_1");
  assert.deepEqual(state.closed, ["ap_1"], "closed once");
});

test("the agent's own frame is used only while no page draws the card", async () => {
  const frame = { approvalId: "ap_9", sessionId: "s1", tool: "os.shell.run", category: "shell", preview: "npm test\nnpm run lint", reason: "no shell guard rule matched" };
  const { n, state } = harness({ page: true });
  assert.equal(await n.fromAgent(frame), false);
  state.page = false;
  assert.equal(await n.fromAgent(frame), true);
  assert.equal(state.shown[0].note.body, 'Fix the login page\nAllow Atomic Agent to run "npm test"?');
  // The window opened again and replayed it: still one.
  state.page = true;
  assert.equal(await n.fromPage(card({ approvalId: "ap_9" })), false);
  assert.equal(state.shown.length, 1);
});

test("the card's words from the request itself: command, host, question, clause, category", () => {
  assert.equal(M.approvalActionText({ category: "shell", preview: "rm -rf build" }).action, 'Allow Atomic Agent to run "rm -rf build"?');
  assert.equal(M.approvalActionText({ category: "http", reason: "POST https://api.example.com/v1/x" }).action, "Allow Atomic Agent to send a POST request to api.example.com?");
  assert.deepEqual(M.approvalActionText({ category: "user_question", question: { prompt: "Which database?" } }), { action: "Which database?", question: true });
  assert.equal(M.approvalActionText({ category: "git_remote", reason: "push main to origin" }).action, "Allow Atomic Agent to push main to origin?");
  assert.equal(M.approvalActionText({ category: "publish", reason: "approval required in /x" }).action, "Allow Atomic Agent to publish to GitHub?");
  assert.equal(M.approvalActionText({ category: "nope" }).action, "Allow Atomic Agent to go ahead?");
  // Raw tool ids never reach the person.
  assert.doesNotMatch(M.approvalActionText({ tool: "os.fs.write", category: "fs_write_workspace" }).action, /os\.fs/);
});

test("a chat's title from GET /api/sessions/{id}", () => {
  assert.equal(M.sessionTitleOf({ metadata: { title: " Fix it " } }), "Fix it");
  assert.equal(M.sessionTitleOf({}), "");
  assert.equal(M.sessionTitleOf(null), "");
});

test("the page's message is checked before anything is raised", () => {
  assert.equal(M.readApprovalDescription(null), null);
  assert.equal(M.readApprovalDescription({ approvalId: "bad id with spaces" }), null);
  assert.deepEqual(M.readApprovalDescription({ approvalId: "ap_1", sessionId: 5, onScreen: "yes" }),
    { approvalId: "ap_1", sessionId: null, chat: "", action: "", question: false, onScreen: false });
});

test("the phone gets a bell, not a finished turn's tick", () => {
  const ON = { enabled: true, server: "https://ntfy.sh", topic: "atag-abc", tokenEnv: "NTFY_TOKEN", subscribeUrl: "https://ntfy.sh/atag-abc" };
  const body = JSON.parse(P.turnPushRequest(ON, { title: "Atomic Agent needs your OK", body: "Fix\nAllow?", waiting: true }, undefined).init.body);
  assert.deepEqual(body.tags, ["bell"]);
  assert.equal(body.priority, 4);
  assert.equal(body.title, "Atomic Agent needs your OK");
  const done = JSON.parse(P.turnPushRequest(ON, { title: "Turn done", body: "3s" }, undefined).init.body);
  assert.deepEqual(done.tags, ["white_check_mark"]);
});

test("page: the card's html question as plain text", () => {
  assert.equal(R.apnPlain('Allow Atomic Agent to run <code>echo &quot;hi&quot; &amp;&amp; ls</code>?'), 'Allow Atomic Agent to run echo "hi" && ls?');
  assert.equal(R.apnPlain(null), "");
});

test("page: the card it holds, on screen or kept for its chat", () => {
  const kept = { k: "approval", approvalId: "a1", sessionId: "s1" };
  const here = { k: "approval", approvalId: "a2", sessionId: "s2" };
  const stored = { k: "approval", approvalId: "a3", stored: true };
  const places = { kept: new Map([["s1", kept]]), log: [here, stored], forChat: () => [] };
  assert.equal(R.apnFindCard("a1", "s1", places), kept);
  assert.equal(R.apnFindCard("a2", "s2", places), here);
  assert.equal(R.apnFindCard("a3", null, places), null, "a stored card is history, not a request");
  assert.equal(R.apnFindCard("zz", "s9", places), null);
});

test("page: what main is told, for a request and for a question", () => {
  const ask = (m) => "Allow Atomic Agent to run <code>" + m.preview + "</code>?";
  const d = R.apnDescribe({ approvalId: "a1", sessionId: "s1", preview: "npm test", cat: "shell" }, { ask, chat: "Fix it", onScreen: true });
  assert.deepEqual(d, { approvalId: "a1", sessionId: "s1", chat: "Fix it", action: "Allow Atomic Agent to run npm test?", question: false, onScreen: true });
  const q = R.apnDescribe({ approvalId: "a2", sessionId: null, cat: "user_question", question: { prompt: "Which one?" } }, { ask, chat: "" });
  assert.equal(q.question, true);
  assert.equal(q.action, "Which one?");
  assert.equal(q.onScreen, false);
  assert.equal(R.apnTarget({ sessionId: "s1" }), "s1");
  assert.equal(R.apnTarget({ sessionId: "../x y" }), null);
});

test("wiring: script tag after renderer.js, preload bridges, main channels and hooks", () => {
  const index = src("../renderer/index.html");
  const tag = index.indexOf('<script src="approval-notify.js">');
  assert.ok(tag > index.indexOf('<script src="renderer.js">'), "after renderer.js, so its card is drawn first");
  assert.ok(tag > index.indexOf('<script src="mini-chat-handoff.js">'), "after mini-chat-handoff.js (mchoOpen)");
  const preload = src("../preload/preload.ts");
  for (const s of ['ipcRenderer.send("approvalNotify:describe"', 'ipcRenderer.invoke("approvalNotify:take")', 'on("approvalNotify:open"']) {
    assert.ok(preload.includes(s), s);
  }
  const ipc = src("../main/approval-notify-ipc.ts");
  for (const s of ['ipcMain.on("approvalNotify:describe"', 'ipcMain.handle("approvalNotify:take"', 'send("approvalNotify:open")', "waiting: true"]) {
    assert.ok(ipc.includes(s), s);
  }
  const main = src("../main/main.ts");
  assert.match(main, /const approvalNote = wireApprovalNotify\(client, /);
  assert.equal((main.match(/approvalNote\.answered\(/g) || []).length, 2, "the card's answer and the question's answer");
  const page = src("../renderer/approval-notify.js");
  for (const s of ["B.approvalNotify(", "B.approvalNotifyTake()", "onApprovalNotifyOpen("]) assert.ok(page.includes(s), s);
});
