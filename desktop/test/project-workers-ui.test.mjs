// ATO-1173: worker chats in the window (renderer/project-workers.js) and the
// hooks that wire them into renderer.js, main.ts, preload.ts and index.html.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const PW = require("../renderer/project-workers.js");
const { chatMenuItems } = require("../renderer/chat-list.js");
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("a worker's badge: live state first, then what main recorded", () => {
  assert.equal(PW.workerBadgeState("working", true, false), "working");
  assert.equal(PW.workerBadgeState("working", true, true), "waiting");
  assert.equal(PW.workerBadgeState("done", false, false), "done");
  assert.equal(PW.workerBadgeState("failed", false, false), "failed");
  assert.equal(PW.workerBadgeState("stopped", false, false), "stopped");
  assert.equal(PW.workerBadgeState(undefined, false, false), "stopped");
  assert.equal(PW.workerEndStatus("done"), "done");
  assert.equal(PW.workerEndStatus("aborted"), "stopped");
  assert.equal(PW.workerEndStatus("error"), "failed");
  assert.equal(PW.coordinatorBadgeText({ workers: [{ status: "done" }, { status: "working" }, { status: "failed" }] }), "2/3 workers");
  assert.deepEqual(PW.pworkersTasks([" a ", "", "b", "c", "d"]), ["a", "b", "c"]);
});

test("the row menu offers Split into worker chats only when asked to", () => {
  assert.ok(!chatMenuItems({}).some((i) => i.verb === "pworkers"));
  const items = chatMenuItems({ workers: true });
  const it = items.find((i) => i.verb === "pworkers");
  assert.equal(it.label, "Split into worker chats…");
  assert.equal(items[items.length - 1].verb, "delask", "Delete stays last");
});

/* The renderer half, in one context with the globals it reads at call time. */
function load() {
  const entry = { value: "", focus() {}, style: {} };
  const ctx = {
    console, setTimeout: () => 0, document: undefined, window: undefined,
    esc: (s) => String(s), ic: (n) => "<" + n + ">", toasts: [], rendered: 0, opened: [], adopted: [], entry,
    sheet: (title, body, foot) => "<sheet " + title + ">" + body + foot,
    RUNNING: new Map(), PENDING_APPROVALS: new Map(), LIVE_TURNS: new Map(),
    SESSIONS: [{ id: "c1", t: "Coordinator", workingDir: "/src/app" }, { id: "c2", t: "Loose", workingDir: "/elsewhere" }],
    S: { sessionId: "c1", room: "chat", overlay: null, draft: "" },
  };
  ctx.toast = (t, s, kind) => ctx.toasts.push({ t, s, kind });
  ctx.render = () => { ctx.rendered++; };
  ctx.renderSidebar = () => {};
  ctx.$ = (sel) => (sel === "#entry" ? entry : null);
  ctx.chatById = (id) => ctx.SESSIONS.find((s) => s.id === id) || null;
  ctx.homeDir = () => "/Users/me";
  ctx.openSession = (id) => { ctx.opened.push(id); };
  ctx.adoptLiveTurns = (list) => { ctx.adopted.push(...list); for (const t of list) ctx.LIVE_TURNS.set(t.turnId, { log: [{ k: "user" }, { k: "system", text: "old" }] }); };
  ctx.BR = {
    projectsStartWorkers: async (p) => { ctx.started = p; return { ok: true, group: { id: "gabc123", coordinatorSid: "c1", projectId: "paaaaaa", workers: [{ sid: "w1", dir: "/st/w1", task: "t1", status: "working" }] }, turns: [{ turnId: "t-1", sessionId: "w1", text: "t1", dir: "/st/w1", firstTurn: true }] }; },
    projectsWorkers: async () => ({ ok: true, data: { groups: [] } }),
  };
  vm.createContext(ctx);
  for (const f of ["chat-list.js", "project-workers.js"]) vm.runInContext(read("../renderer/" + f), ctx, { filename: f });
  vm.runInContext("var PROJECTS = {state: projectsCoerce({projects: [{id: 'paaaaaa', name: 'app', folder: '/src/app'}]})};", ctx);
  return ctx;
}

test("only a stored chat in a project with a folder, not a worker, can split", () => {
  const c = load();
  assert.equal(vm.runInContext("pworkersCanSplit('c1')", c), true);
  assert.equal(vm.runInContext("pworkersCanSplit('c2')", c), false, "not in a project");
  assert.equal(vm.runInContext("pworkersCanSplit('nope')", c), false, "not stored");
  vm.runInContext("PWORKERS.groups = [{id: 'gabc123', coordinatorSid: 'c2', workers: [{sid: 'c1', dir: '/st/w', status: 'working'}]}]", c);
  assert.equal(vm.runInContext("pworkersCanSplit('c1')", c), false, "a worker does not split again");
});

test("the badge follows RUNNING, PENDING_APPROVALS and the recorded end", () => {
  const c = load();
  vm.runInContext("PWORKERS.groups = [{id: 'gabc123', coordinatorSid: 'c1', workers: [{sid: 'w1', dir: '/st/w1', status: 'working'}, {sid: 'w2', dir: '/st/w2', status: 'working'}]}]", c);
  c.RUNNING.set("t-1", "w1");
  assert.match(vm.runInContext("workerBadgeHTML('w1')", c), /pw-working/);
  c.PENDING_APPROVALS.set("w1", "a1");
  assert.match(vm.runInContext("workerBadgeHTML('w1')", c), />waiting</);
  c.PENDING_APPROVALS.delete("w1");
  c.RUNNING.delete("t-1");
  vm.runInContext("workerTurnEnded('w1', 'done')", c);
  assert.match(vm.runInContext("workerBadgeHTML('w1')", c), /pw-done/);
  vm.runInContext("workerTurnEnded('w2', 'error')", c);
  assert.match(vm.runInContext("workerBadgeHTML('w2')", c), /pw-failed/);
  assert.match(vm.runInContext("workerBadgeHTML('c1')", c), /2\/2 workers/);
  assert.equal(vm.runInContext("workerBadgeHTML('c2')", c), "");
});

test("Start sends the tasks, takes the turns over in the background and relabels their line", async () => {
  const c = load();
  vm.runInContext("pworkersAct('pworkers', 'c1')", c);
  assert.equal(c.S.overlay, "pworkers");
  assert.match(vm.runInContext("pworkersSheetHTML()", c), /<sheet Split into worker chats>.*pw-task-2.*data-act="pwstart:"/s);
  vm.runInContext("PWORKERS.sheet.tasks = ['  fix login ', '', 'docs']", c);
  vm.runInContext("pworkersAct('pwstart', '')", c);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(JSON.parse(JSON.stringify(c.started)), { coordinatorSid: "c1", projectId: "paaaaaa", tasks: ["fix login", "docs"] });
  assert.equal(c.adopted[0].turnId, "t-1");
  assert.match(c.LIVE_TURNS.get("t-1").log[1].text, /Worker chat\. .*\/st\/w1/);
  assert.equal(c.S.overlay, null);
  assert.match(c.toasts.at(-1).t, /worker chats? started/);
});

test("the report goes into the coordinator's box when it is on screen, else when it is opened", () => {
  const c = load();
  const group = { id: "gabc123", coordinatorSid: "c1", workers: [{ sid: "w1", dir: "/st/w1", status: "done" }] };
  vm.runInContext("pworkersChanged", c)({ group, report: "Worker results:\n- t1: ok" });
  assert.equal(c.entry.value, "Worker results:\n- t1: ok");
  assert.equal(c.S.draft, "Worker results:\n- t1: ok");

  const d = load();
  d.S.sessionId = "c2";
  vm.runInContext("pworkersChanged", d)({ group, report: "R" });
  assert.equal(d.entry.value, "", "not sent, not put in another chat's box");
  assert.match(d.toasts.at(-1).s, /Coordinator/);
  d.S.sessionId = "c1";
  vm.runInContext("pworkersStashBack('c1')", d);
  assert.equal(d.entry.value, "R");

  const e = load();
  e.entry.value = "typing";
  vm.runInContext("pworkersChanged", e)({ group, report: "R" });
  assert.equal(e.entry.value, "typing", "a draft is never overwritten");
});

test("renderer.js hooks: row badge, menu item, sheet, act, turn end, open", () => {
  const src = read("../renderer/renderer.js");
  const row = src.slice(src.indexOf("\nfunction chatRow("), src.indexOf("\nlet CHAT_AGE_TICK"));
  assert.match(row, /'<span class="t1">' \+ esc\(s\.t\) \+ '<\/span>'\n\s*\+ \(typeof workerBadgeHTML === 'function' \? workerBadgeHTML\(s\.id\) : ''\)/);
  const menu = src.slice(src.indexOf("\nfunction chatMenuHTML("), src.indexOf("\nfunction chatQueuedCount("));
  assert.match(menu, /workers: typeof pworkersCanSplit === 'function' && pworkersCanSplit\(id\),/);
  assert.match(src, /if \(S\.overlay === 'pworkers'\) html \+= pworkersSheetHTML\(\);/);
  assert.match(src, /if \(k === 'pworkers' \|\| k === 'pwstart' \|\| k === 'pwfill'\) \{ pworkersAct\(k, v \|\| ''\); return; \}/);
  const end = src.slice(src.indexOf("if (ev.kind === 'done' || ev.kind === 'aborted' || ev.kind === 'error') {\n      const sid = RUNNING.get(ev.turnId);"));
  assert.match(end.slice(0, 1200), /goalTurnEnded\(sid\);[^\n]*\n\s*if \(sid && typeof workerTurnEnded === 'function'\) workerTurnEnded\(sid, ev\.kind\);/);
  assert.match(src, /rollbackStashBack\(id\);[^\n]*\n\s*if \(typeof pworkersStashBack === 'function'\) pworkersStashBack\(id\);/);
  const html = read("../renderer/index.html");
  const at = html.indexOf('src="project-workers.js"');
  assert.ok(at > html.indexOf('src="chat-projects.js"') && at < html.indexOf('src="renderer.js"'));
  assert.ok(html.indexOf('href="css/project-workers.css"') > 0);
});

test("main.ts: startTurn takes a worker's folder, and the worker IPC is wired with it", () => {
  const src = read("../main/main.ts");
  assert.match(src, /turnModel: ProjectModelPick \| null = null,\n\s*\/\*\*[^\n]*ATO-1173[^\n]*\*\/\n\s*workDir\?: string,\n\s*\): Promise</);
  // `sent` (ATO-1593 @file mentions) and a chat's own branch (ATO-576) may join the same call; the worker's folder still wins.
  assert.match(src, /void client\.chat\(turnId, (?:clean|sent), chatId, workDir \?\? (?:inWorktree\?\.dir \?\? )?proj\.workingDir, instructions, reasoning, turnModel \?\? undefined\);/);
  assert.match(src, /wireProjectWorkersIpc\(\{[\s\S]{0,200}startTurn, isRemote: \(\) => client\.isRemote,/);
  const pre = read("../preload/preload.ts");
  for (const ch of ["projects:startWorkers", "projects:workers", "projects:workersStarted", "projects:workersChanged"]) assert.ok(pre.includes(`"${ch}"`), ch);
});
