// ATO-2257: the task board. main/workboard-move.ts is checked against the
// built output (npm run build first); the pure half of renderer/workboard.js
// is loaded as a CommonJS module, like agent-hub.js. The last test pins the
// one-line hooks in renderer.js, index.html, main.ts and preload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/workboard-move.js");
const R = require("../renderer/workboard.js");

const card = (id, lane, extra = {}) => ({
  task: { id, status: "pending", userMessage: "Write the release notes\nand post them", updatedAt: 1, ...extra.task },
  lane,
  laneSource: "status",
  note: null,
  assignee: null,
  ...extra,
});

/* ---- main: what may reach POST /api/tasks/{id}/board ---- */

test("a move keeps only lane, note and assignee, each checked", () => {
  assert.deepEqual(M.cleanBoardMove({ lane: "review", extra: "dropped" }), { ok: true, body: { lane: "review" } });
  assert.deepEqual(M.cleanBoardMove({ lane: null, note: null, assignee: "" }), { ok: true, body: { lane: null, note: null, assignee: null } });
  assert.deepEqual(M.cleanBoardMove({ note: "check it", assignee: " coder " }), { ok: true, body: { note: "check it", assignee: "coder" } });
  assert.deepEqual(M.WORKBOARD_LANES, ["todo", "doing", "review", "blocked", "done"]);
});

test("a move with nothing in it, a bad lane, a long note or a bad assignee is refused", () => {
  for (const raw of [null, [], "review", {}, { other: 1 }]) assert.equal(M.cleanBoardMove(raw).ok, false, JSON.stringify(raw));
  assert.equal(M.cleanBoardMove({ lane: "archive" }).ok, false);
  assert.equal(M.cleanBoardMove({ lane: 2 }).ok, false);
  assert.equal(M.cleanBoardMove({ note: "x".repeat(2001) }).ok, false);
  assert.equal(M.cleanBoardMove({ note: 5 }).ok, false);
  assert.equal(M.cleanBoardMove({ assignee: "Coder Bot" }).ok, false);
  assert.equal(M.cleanBoardMove({ assignee: "../x" }).ok, false);
});

/* ---- renderer: lanes, moves and cards ---- */

test("cards fall into every lane in board order; an unknown lane reads as To do", () => {
  const groups = R.wbGroup([card("t-1", "doing"), card("t-2", "review"), card("t-3", "weird"), { task: { id: "bad id!" }, lane: "done" }, null]);
  assert.deepEqual(groups.map((g) => g.lane), ["todo", "doing", "review", "blocked", "done"]);
  assert.deepEqual(groups.map((g) => g.label), ["To do", "In progress", "Review", "Blocked", "Done"]);
  assert.deepEqual(groups.map((g) => g.cards.map((c) => c.task.id)), [["t-3"], ["t-1"], ["t-2"], [], []]);
});

test("a card may move to a known lane other than its own; the move is applied before the agent answers", () => {
  const c = card("t-1", "todo");
  assert.equal(R.wbCanMove(c, "review").ok, true);
  assert.equal(R.wbCanMove(c, "todo").ok, false);
  assert.equal(R.wbCanMove(c, "archive").ok, false);
  assert.equal(R.wbCanMove(null, "done").ok, false);
  const after = R.wbApplyMove([c, card("t-2", "done")], "t-1", "review");
  assert.deepEqual(after.map((x) => [x.task.id, x.lane, x.laneSource]), [["t-1", "review", "board"], ["t-2", "done", "status"]]);
  assert.equal(c.lane, "todo", "the old list is left as it was, to put back on a refusal");
});

test("the note form makes the patch main checks; a bad assignee is an error line", () => {
  assert.deepEqual(R.wbEditPatch({ note: "  see logs ", assignee: "" }), { ok: true, patch: { note: "see logs", assignee: null } });
  assert.deepEqual(R.wbEditPatch({ note: "", assignee: "reviewer" }), { ok: true, patch: { note: null, assignee: "reviewer" } });
  assert.equal(R.wbEditPatch({ assignee: "Not Valid" }).ok, false);
  assert.equal(R.wbEditPatch({ note: "x".repeat(2001) }).ok, false);
});

test("a card shows the message's first line, assignee and note, escaped, and is draggable with Run now", () => {
  const html = R.wbCardHTML(card("t-1", "review", { assignee: "writer", note: "<b>check</b>" }), {});
  assert.match(html, /draggable="true" data-wb-id="t-1"/);
  assert.match(html, /Write the release notes</);
  assert.doesNotMatch(html, /and post them/);
  assert.match(html, /@writer/);
  assert.match(html, /&lt;b&gt;check&lt;\/b&gt;/);
  assert.match(html, /data-act="board:run:t-1"/);
  assert.match(html, /<option value="review" selected>/);
  const running = R.wbCardHTML(card("t-2", "doing", { task: { id: "t-2", status: "running" } }), {});
  assert.match(running, /data-act="board:run:t-2" disabled/);
  const editing = R.wbCardHTML(card("t-1", "todo"), { editing: "t-1", draft: { note: "a", assignee: "b" } });
  assert.match(editing, /data-act="board:save:t-1"/);
  assert.match(editing, /data-wb-draft="note"/);
});

test("the board draws five lanes with counts and a drop line in empty ones", () => {
  const html = R.wbBoardHTML([card("t-1", "done")], {});
  for (const lane of ["todo", "doing", "review", "blocked", "done"]) assert.ok(html.includes('data-wb-lane="' + lane + '"'), lane);
  assert.match(html, /Done <span class="wb-lane-n">1<\/span>/);
  assert.equal((html.match(/Drop a card here/g) || []).length, 4);
});

test("hooks: sidebar row, renderer.js room and act, index.html, main.ts and preload", () => {
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.match(src, /if \(S\.room === 'board'\)  \{ c\.innerHTML = workboardView\(\); return; \}/);
  assert.match(src, /if \(k === 'board'\) \{ if \(v === 'open'\) close\(\); boardAct\(v \|\| ''\); return; \}/);
  assert.match(src, /\['tasks','Task board','','','board:open'\]/);
  const nav = readFileSync(new URL("../renderer/sidebar-nav.js", import.meta.url), "utf8");
  assert.match(nav, /act: 'board:open'/);
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('src="workboard.js"') > 0 && html.indexOf('src="workboard.js"') < html.indexOf('src="renderer.js"'));
  assert.ok(html.includes('href="css/workboard.css"'));
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.match(main, /import \{ wireWorkboardIpc \} from "\.\/workboard-ipc\.js";/);
  assert.match(main, /wireWorkboardIpc\(\{ client \}\);/);
  const pre = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.match(pre, /taskBoard: \(\) => ipcRenderer\.invoke\("agent:taskBoard"\)/);
  assert.match(pre, /moveTaskCard: \(id: string, patch: unknown\) => ipcRenderer\.invoke\("agent:moveTaskCard", id, patch\)/);
  const ipc = readFileSync(new URL("../main/workboard-ipc.ts", import.meta.url), "utf8");
  assert.match(ipc, /cleanBoardMove\(patch\)/, "main checks the move before it reaches the agent");
  const client = readFileSync(new URL("../main/agent-client.ts", import.meta.url), "utf8");
  assert.match(client, /\/api\/task-board\?limit=/);
  assert.match(client, /\/board`, body\)/);
});

/* ---- ATO-2498: dependencies, comments, profile picker ---- */

const T = require("../renderer/workboard-thread.js");

test("a move may carry the cards it waits on; ids are checked and capped", () => {
  assert.deepEqual(M.cleanBoardMove({ dependsOn: ["t-1", "t-2", "t-1"] }), { ok: true, body: { dependsOn: ["t-1", "t-2"] } });
  assert.deepEqual(M.cleanBoardMove({ dependsOn: null }), { ok: true, body: { dependsOn: null } });
  assert.equal(M.cleanBoardMove({ dependsOn: ["bad id!"] }).ok, false);
  assert.equal(M.cleanBoardMove({ dependsOn: "t-1" }).ok, false);
  assert.equal(M.cleanBoardMove({ dependsOn: Array.from({ length: 21 }, (_, i) => "t-" + i) }).ok, false);
  assert.deepEqual(M.cleanBoardMove({ assignee: "review-kit:checker" }), { ok: true, body: { assignee: "review-kit:checker" } });
});

test("a comment is trimmed text of at most 2000 characters", () => {
  assert.deepEqual(M.cleanBoardComment("  looks good "), { ok: true, text: "looks good" });
  for (const raw of ["   ", "", null, 5, "x".repeat(2001)]) assert.equal(M.cleanBoardComment(raw).ok, false, String(raw).slice(0, 10));
});

test("the edit form sends the picked waits with the note and assignee", () => {
  assert.deepEqual(R.wbEditPatch({ note: "", assignee: "", dependsOn: ["t-2", "bad id!"] }), { ok: true, patch: { note: null, assignee: null, dependsOn: ["t-2"] } });
  assert.deepEqual(R.wbEditPatch({ note: "", assignee: "kit:agent" }), { ok: true, patch: { note: null, assignee: "kit:agent" } });
  assert.deepEqual(T.wxToggleDep(["t-1"], "t-2", true), ["t-1", "t-2"]);
  assert.deepEqual(T.wxToggleDep(["t-1", "t-2"], "t-1", false), ["t-2"]);
  assert.deepEqual(T.wxToggleDep(Array.from({ length: 20 }, (_, i) => "t-" + i), "t-x", true).length, 20);
});

test("a card shows its comment count and what it waits on, and Run now asks first", () => {
  const waiting = card("t-1", "todo", { commentCount: 2, waitingOn: ["t-9"] });
  const badges = T.wxBadgesHTML(waiting);
  assert.match(badges, /data-act="board:thread:t-1">2 comments</);
  assert.match(badges, /Waiting on 1/);
  assert.doesNotMatch(T.wxBadgesHTML(card("t-2", "todo")), /Waiting on/);
  assert.match(T.wxRunQuestion(waiting), /waits on 1 card that is not done/);
  assert.equal(T.wxRunQuestion(card("t-2", "todo", { waitingOn: [] })), null);
  assert.match(T.wxRunConfirmHTML("t-1", "Run?"), /data-act="board:runanyway:t-1"/);
});

test("the assignee is a profile list, with a loading state and a typed fallback", () => {
  const list = { list: [{ name: "writer", description: "writes <notes>" }, { name: "review", description: "" }], loading: false, error: null };
  const picker = T.wxAssigneeHTML(list, "writer");
  assert.match(picker, /<select data-wb-draft="assignee"/);
  assert.match(picker, /<option value="writer" selected/);
  assert.match(picker, /No one \(the main agent\)/);
  assert.match(picker, /writes &lt;notes&gt;/);
  assert.match(T.wxAssigneeHTML(list, "gone"), /gone \(not found\)/);
  assert.match(T.wxAssigneeHTML({ loading: true }, ""), /Loading profiles/);
  const fallback = T.wxAssigneeHTML({ list: null, loading: false, error: "x" }, "coder");
  assert.match(fallback, /<input data-wb-draft="assignee"[^>]*value="coder"/);
  assert.match(fallback, /Could not read the profiles/);
});

test("the waits list offers every other card, ticked when picked", () => {
  const cards = [card("t-1", "todo"), card("t-2", "done"), card("t-3", "todo")];
  const html = T.wxDepsHTML(cards, "t-1", ["t-3"]);
  assert.doesNotMatch(html, /data-wb-dep="t-1"/);
  assert.match(html, /data-wb-dep="t-2">/);
  assert.match(html, /data-wb-dep="t-3" checked/);
  assert.equal(T.wxDepsHTML([card("t-1", "todo")], "t-1", []), "");
});

test("the thread shows its states, oldest first, with a notice's details behind Details", () => {
  assert.match(T.wxThreadHTML("t-1", { loading: true }), /Reading comments/);
  assert.match(T.wxThreadHTML("t-1", { comments: [] }), /No comments yet/);
  assert.match(T.wxThreadHTML("t-1", { error: "boom /Users/x" }), /Could not read the comments/);
  assert.doesNotMatch(T.wxThreadHTML("t-1", { error: "boom /Users/x" }), /Users/);
  assert.match(T.wxThreadHTML("t-1", { unsupported: true }), /Update Atomic Agent/);
  const html = T.wxThreadHTML("t-1", {
    comments: [
      { id: 2, author: "system", kind: "fuse", text: "Stopped after 3 failed runs in a row.\nLast error: <timeout>", createdAt: 2 },
      { id: 1, author: "person", kind: "comment", text: "please check", createdAt: 1 },
    ],
  });
  assert.ok(html.indexOf("please check") < html.indexOf("Stopped after"), "oldest first");
  assert.match(html, /Atomic Agent/);
  assert.match(html, /<summary>Details<\/summary><pre>Last error: &lt;timeout&gt;<\/pre>/);
  assert.match(html, /data-act="board:comment:t-1"/);
});

test("ATO-2498 hooks: script tag, IPC, client and preload", () => {
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('src="workboard-thread.js"') > 0 && html.indexOf('src="workboard-thread.js"') < html.indexOf('src="workboard.js"'));
  const ipc = readFileSync(new URL("../main/workboard-ipc.ts", import.meta.url), "utf8");
  for (const ch of ["agent:boardComments", "agent:addBoardComment", "agent:boardProfiles"]) assert.ok(ipc.includes(`"${ch}"`), ch);
  assert.match(ipc, /cleanBoardComment\(text\)/);
  const pre = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.match(pre, /boardComments: \(id: string\) => ipcRenderer\.invoke\("agent:boardComments", id\)/);
  assert.match(pre, /addBoardComment: \(id: string, text: string\) => ipcRenderer\.invoke\("agent:addBoardComment", id, text\)/);
  assert.match(pre, /boardProfiles: \(taskId\?: string\) => ipcRenderer\.invoke\("agent:boardProfiles", taskId\)/);
  const client = readFileSync(new URL("../main/agent-client.ts", import.meta.url), "utf8");
  assert.match(client, /\/board\/comments\?limit=100/);
  assert.match(client, /\/api\/task-board\/profiles/);
  const board = readFileSync(new URL("../renderer/workboard.js", import.meta.url), "utf8");
  assert.match(board, /wxAct\(verb, id\)/);
  assert.match(board, /wxRunQuestion\(wbFind\(id\)\)/);
});
