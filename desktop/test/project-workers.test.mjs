// ATO-1173: worker chats, each in its own copy of the project folder. Unit
// tests for main/project-workers.ts and main/project-workers-store.ts,
// against the built output. Run: npm run build && npm run test:unit
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const W = require("../out/main/project-workers.js");
const St = require("../out/main/project-workers-store.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp(tag) {
  const d = mkdtempSync(join(tmpdir(), `aa-workers-${tag}-`));
  dirs.push(d);
  return d;
}

/** A command runner that records every call; `answer(file, args)` returns stdout or throws. */
function stubExec(answer) {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts });
    const out = await answer(file, args);
    return { stdout: out ?? "", stderr: "" };
  };
  return { exec, calls };
}
const notGit = (file) => { if (file === "git") throw new Error("fatal: not a git repository"); };

test("planWorkers: 1 to 3 tasks, trimmed, empty ones dropped, each capped", () => {
  assert.deepEqual(W.planWorkers(["  fix the login  ", "", "   ", "write tests"]), { ok: true, tasks: ["fix the login", "write tests"] });
  assert.equal(W.planWorkers([]).ok, false);
  assert.equal(W.planWorkers(["", " "]).ok, false);
  assert.equal(W.planWorkers("one task").ok, false);
  const four = W.planWorkers(["a", "b", "c", "d"]);
  assert.equal(four.ok, false);
  assert.match(four.error, /At most 3/);
  const long = W.planWorkers(["x".repeat(W.MAX_TASK_CHARS + 50)]);
  assert.equal(long.tasks[0].length, W.MAX_TASK_CHARS);
  assert.deepEqual(W.planWorkers([1, null, "ok"]).tasks, ["ok"]);
});

test("workerPrompt asks for a short summary for the coordinator", () => {
  const p = W.workerPrompt("  Add a dark theme\n");
  assert.ok(p.startsWith("Add a dark theme\n\n"));
  assert.ok(p.endsWith("When you finish, end with a short summary (at most 5 lines) for the coordinator: what changed and where."));
});

test("workerKey is one safe folder name", () => {
  assert.equal(W.workerKey("pabc123", 36, 2), "pabc123-10-2");
  assert.equal(W.workerKey("../p/../x", 1, 1), "px-1-1");
});

test("a folder in git gets a detached worktree of HEAD, by execFile argv (no shell)", async () => {
  const project = tmp("repo");
  const state = tmp("state");
  const { exec, calls } = stubExec((file, args) => (args.includes("rev-parse") ? project + "\n" : ""));
  const r = await W.makeWorkerDir(project, state, "pabc-1-1", exec, "darwin");
  assert.equal(r.ok, true);
  assert.equal(r.kind, "worktree");
  const root = join(state, "worktrees", "pabc-1-1");
  assert.equal(r.root, root);
  assert.equal(r.dir, root);
  assert.deepEqual(calls.map((c) => [c.file, c.args]), [
    ["git", ["-C", project, "rev-parse", "--show-toplevel"]],
    ["git", ["-C", project, "worktree", "add", "--detach", root, "HEAD"]],
  ]);
  for (const c of calls) {
    assert.ok(Array.isArray(c.args), "argv, never a command line");
    assert.equal(c.opts?.shell, undefined);
  }
});

test("a project on a subfolder of a repo works in the same subfolder of its worktree", async () => {
  const top = tmp("mono");
  const sub = join(top, "apps", "web");
  mkdirSync(sub, { recursive: true });
  const state = tmp("state");
  const { exec, calls } = stubExec((file, args) => (args.includes("rev-parse") ? top : ""));
  const r = await W.makeWorkerDir(sub, state, "pweb-1-1", exec, "linux");
  assert.equal(r.ok, true);
  assert.equal(r.dir, join(state, "worktrees", "pweb-1-1", "apps", "web"));
  assert.deepEqual(calls[1].args.slice(0, 2), ["-C", top]);
});

test("a failed git worktree add is an error, not a copy", async () => {
  const project = tmp("repo");
  const { exec } = stubExec((file, args) => {
    if (args.includes("rev-parse")) return project;
    throw new Error("fatal: invalid reference: HEAD\nmore");
  });
  const r = await W.makeWorkerDir(project, tmp("state"), "p-1-1", exec, "linux");
  assert.equal(r.ok, false);
  assert.match(r.error, /git worktree add failed: fatal: invalid reference: HEAD$/);
});

test("on macOS a folder without git is cloned with cp -c -R", async () => {
  const project = tmp("plain");
  const state = tmp("state");
  const { exec, calls } = stubExec(notGit);
  const r = await W.makeWorkerDir(project + "/", state, "pplain-1-1", exec, "darwin");
  assert.equal(r.ok, true);
  assert.equal(r.kind, "copy");
  const root = join(state, "worktrees", "pplain-1-1");
  assert.deepEqual(calls[1], { file: "cp", args: ["-c", "-R", project, root], opts: calls[1].opts });
});

test("without a clone the folder is copied file by file", async () => {
  const project = tmp("plain");
  writeFileSync(join(project, "a.txt"), "hello");
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "src", "b.js"), "x = 1");
  const state = tmp("state");
  // cp -c fails (not APFS) and leaves nothing: the plain copy takes over.
  const { exec } = stubExec((file) => { notGit(file); if (file === "cp") throw new Error("cp: clonefile failed"); });
  const r = await W.makeWorkerDir(project, state, "pplain-2-1", exec, "darwin");
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(r.root, "a.txt"), "utf8"), "hello");
  assert.equal(readFileSync(join(r.root, "src", "b.js"), "utf8"), "x = 1");
  assert.ok(existsSync(join(project, "a.txt")), "the project folder is untouched");
});

test("a copy is refused past the caps, over a target already there, and inside the folder it copies", async () => {
  const project = tmp("plain");
  for (let i = 0; i < 5; i++) writeFileSync(join(project, `f${i}`), "1234567890");
  assert.match(await W.folderTooBig(project, { files: 3, bytes: 1e9 }), /more than 3 files/);
  assert.match(await W.folderTooBig(project, { files: 100, bytes: 25 }), /larger than/);
  assert.equal(await W.folderTooBig(project, { files: 100, bytes: 1e9 }), null);

  const state = tmp("state");
  mkdirSync(join(state, "worktrees", "ptaken-1-1"), { recursive: true });
  const { exec, calls } = stubExec(notGit);
  const taken = await W.makeWorkerDir(project, state, "ptaken-1-1", exec, "linux");
  assert.equal(taken.ok, false);
  assert.equal(calls.length, 0, "nothing runs for a target already there");

  const inside = await W.makeWorkerDir(project, join(project, ".atomic-agent"), "pin-1-1", exec, "linux");
  assert.equal(inside.ok, false);
  assert.equal((await W.makeWorkerDir(join(project, "missing"), state, "pm-1-1", exec, "linux")).ok, false);
  assert.equal((await W.makeWorkerDir(project, state, "../evil", exec, "linux")).ok, false);
});

test("replySummary keeps the last 5 non-empty lines, capped", () => {
  assert.equal(W.replySummary("intro\n\n1\n2\n3\n4\n5\n"), "1\n2\n3\n4\n5");
  assert.equal(W.replySummary(""), "");
  const long = W.replySummary("y".repeat(2000));
  assert.equal(long.length, W.MAX_SUMMARY_CHARS);
  assert.ok(long.startsWith("…"));
});

test("coordinatorReport lists each worker's summary and folder", () => {
  const text = W.coordinatorReport([
    { task: "Fix the login\nmore detail", dir: "/s/w1", status: "done", summary: "Changed auth.ts\nAdded a test" },
    { task: "Docs", dir: "/s/w2", status: "failed", summary: "" },
  ]);
  assert.equal(text, "Worker results:\n- Fix the login:\n  Changed auth.ts\n  Added a test\n  Folder: /s/w1\n- Docs [failed]: (failed, no summary)\n  Folder: /s/w2");
});

const worker = (sid, extra = {}) => ({ sid, dir: `/s/${sid}`, root: `/s/${sid}`, kind: "worktree", task: `task ${sid}`, status: "working", summary: "", endedAt: 0, ...extra });

test("the store keeps valid groups only, and a worker's end is recorded", () => {
  const raw = {
    groups: [
      { id: "gabc123", coordinatorSid: "c1", projectId: "pabcdef", createdAt: 5, workers: [worker("w1"), { sid: "w2", dir: "relative", task: "x" }, worker("w3", { status: "bogus" })] },
      { id: "bad id", coordinatorSid: "c2", projectId: "p1", workers: [worker("w4")] },
      { id: "gabc123", coordinatorSid: "c3", projectId: "p1", workers: [worker("w5")] },
      { id: "gempty1", coordinatorSid: "c4", projectId: "p1", workers: [] },
    ],
  };
  const d = St.coerceWorkers(raw);
  assert.equal(d.groups.length, 1);
  assert.deepEqual(d.groups[0].workers.map((w) => [w.sid, w.status]), [["w1", "working"], ["w3", "stopped"]]);
  assert.deepEqual(St.coerceWorkers(null), St.emptyWorkers());

  const ended = St.endWorker(d, "w1", "done", "all good", 9);
  assert.equal(ended.group.workers[0].status, "done");
  assert.equal(ended.group.workers[0].endedAt, 9);
  assert.equal(St.groupEnded(ended.group), true);
  assert.equal(St.endWorker(d, "nope", "done", ""), null);
  assert.equal(d.groups[0].workers[0].status, "working", "pure: the input is unchanged");
  assert.match(St.groupReport(ended.group), /^Worker results:\n- task w1: all good/);
});

test("the store reads and writes ~/.atomic-agent/project-workers.json", () => {
  const state = tmp("state");
  assert.deepEqual(St.readWorkers(state), St.emptyWorkers());
  const g = { id: St.newGroupId(), coordinatorSid: "c1", projectId: "pabcdef", createdAt: 1, workers: [worker("w1")] };
  assert.equal(St.writeWorkers(state, St.addGroup(St.emptyWorkers(), g)), true);
  assert.equal(St.workersPath(state), join(state, "project-workers.json"));
  assert.equal(St.readWorkers(state).groups[0].id, g.id);
  writeFileSync(St.workersPath(state), "{not json");
  assert.deepEqual(St.readWorkers(state), St.emptyWorkers());
  assert.equal(existsSync(St.workersPath(state)), false, "a bad file is set aside, not overwritten");
});

test("a worker whose turn this run does not follow is listed as stopped", () => {
  const d = { version: 1, groups: [{ id: "gabc123", coordinatorSid: "c", projectId: "p", createdAt: 1, workers: [worker("w1"), worker("w2")] }] };
  const l = St.listedWorkers(d, (sid) => sid === "w2");
  assert.deepEqual(l.groups[0].workers.map((w) => w.status), ["stopped", "working"]);
});

test("replyStep: the reply after the last tool call, and how the turn ended", () => {
  const st = St.emptyReply();
  assert.equal(St.replyStep(st, { kind: "delta", text: "Let me look. " }), null);
  assert.equal(St.replyStep(st, { kind: "tool_progress", payload: {} }), null);
  St.replyStep(st, { kind: "delta", text: "Done.\nChanged a.ts" });
  assert.equal(st.last, "Done.\nChanged a.ts");
  assert.equal(St.replyStep(st, { kind: "done" }), "done");
  const bad = St.emptyReply();
  St.replyStep(bad, { kind: "error", payload: { error: "boom" } });
  assert.equal(St.replyStep(bad, { kind: "done" }), "failed");
  assert.equal(St.replyStep(St.emptyReply(), { kind: "aborted" }), "stopped");
  assert.equal(St.replyStep(St.emptyReply(), { kind: "error", error: "x" }), "failed");
});

test("the IPC runs commands through execFile, never a shell", () => {
  const src = readFileSync(new URL("../main/project-workers-ipc.ts", import.meta.url), "utf8");
  assert.match(src, /promisify\(execFile\)/);
  assert.doesNotMatch(src, /shell:\s*true/);
  assert.doesNotMatch(src, /\bexec\(\s*["'`]/);
  assert.match(src, /deps\.isRemote\(\)/);
  assert.match(src, /projectId\.startsWith\("f"\)/);
});
