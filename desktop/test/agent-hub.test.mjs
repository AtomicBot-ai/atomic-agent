// ATO-1157: the Agents sheet. main/agent-hub-scan.ts (and the classifiers
// it re-exports) is checked against the built output (npm run build first),
// on a fake disk; the pure half of renderer/agent-hub.js is loaded as a
// CommonJS module, like handoff.js. The last test pins the one-line hooks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/agent-hub-scan.js");
const R = require("../renderer/agent-hub.js");

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const j = (o) => JSON.stringify(o);

/* ---- Claude Code rows ---- */
const cUser = (text, extra = {}) => j({ type: "user", cwd: "/w/app", message: { role: "user", content: text }, ...extra });
const cText = (text, extra = {}) => j({ type: "assistant", cwd: "/w/app", message: { role: "assistant", content: [{ type: "text", text }] }, ...extra });
const cTool = (id) => j({ type: "assistant", cwd: "/w/app", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: {} }] } });
const cResult = (id) => j({ type: "user", cwd: "/w/app", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

/* ---- Codex rows ---- */
const xMeta = (id, cwd = "/w/api") => j({ type: "session_meta", payload: { id, cwd } });
const xUser = (text) => j({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const xText = (text) => j({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const xCall = (id) => j({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}", call_id: id } });
const xOut = (id) => j({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: "done" } });
const xDone = () => j({ type: "event_msg", payload: { type: "task_complete" } });

test("Claude Code: a tool call with no result waits for approval", () => {
  const c = M.classifyClaudeTail([cUser("fix the build"), cTool("t1")], { ageMs: MIN });
  assert.equal(c.state, "waiting");
  assert.equal(c.reason, "approval pending");
  assert.equal(c.cwd, "/w/app");
  assert.equal(c.title, "fix the build");
});

test("Claude Code: parallel calls, the newest one unanswered still waits", () => {
  const c = M.classifyClaudeTail([cTool("a"), cTool("b"), cResult("a")], { ageMs: MIN });
  assert.equal(c.reason, "approval pending");
});

test("Claude Code: a reply at the end is your turn; very fresh it is still running; hours old it is idle", () => {
  const lines = [cUser("hi"), cTool("t1"), cResult("t1"), cText("All done.")];
  assert.deepEqual([M.classifyClaudeTail(lines, { ageMs: MIN }).state, M.classifyClaudeTail(lines, { ageMs: MIN }).reason], ["waiting", "your turn"]);
  assert.equal(M.classifyClaudeTail(lines, { ageMs: 1000 }).state, "running");
  assert.equal(M.classifyClaudeTail(lines, { ageMs: 3 * 60 * MIN }).state, "idle");
});

test("Claude Code: a tool result or a user message at the end runs while the file moves, then idles", () => {
  const lines = [cTool("t1"), cResult("t1")];
  assert.equal(M.classifyClaudeTail(lines, { ageMs: 10_000 }).state, "running");
  assert.equal(M.classifyClaudeTail(lines, { ageMs: 5 * MIN }).state, "idle");
  assert.equal(M.classifyClaudeTail([cUser("go")], { ageMs: 2000 }).state, "running");
});

test("Claude Code: interrupted is idle, an API error (a limit) waits", () => {
  assert.equal(M.classifyClaudeTail([cTool("t1"), cUser("[Request interrupted by user for tool use]")], { ageMs: MIN }).reason, "interrupted");
  const lim = M.classifyClaudeTail([cUser("go"), cText("Claude AI usage limit reached", { isApiErrorMessage: true })], { ageMs: MIN });
  assert.equal(lim.state, "waiting");
  assert.match(lim.reason, /limit/);
});

test("Claude Code: sidechain rows are ignored", () => {
  const lines = [cUser("main task"), cText("Here it is."), cTool("sub1").replace('"type":"assistant"', '"type":"assistant","isSidechain":true')];
  const c = M.classifyClaudeTail(lines, { ageMs: MIN });
  assert.equal(c.reason, "your turn");
  const side = M.classifyClaudeTail([j({ type: "user", isSidechain: true, cwd: "/sub", message: { content: "x" } })], { ageMs: MIN });
  assert.equal(side.reason, "no messages yet");
  assert.equal(side.cwd, null);
});

test("Claude Code: custom-title beats ai-title, from the head or the tail", () => {
  const head = [j({ type: "ai-title", aiTitle: "AI name" })];
  assert.equal(M.classifyClaudeTail([cUser("x")], { headLines: head }).title, "AI name");
  assert.equal(M.classifyClaudeTail([cUser("x"), j({ type: "custom-title", customTitle: "Mine" })], { headLines: head }).title, "Mine");
});

test("garbage lines never throw and are skipped", () => {
  const junk = ["", "not json", "{", "[1,2]", "null", "{\"type\":\"assistant\",\"message\":7}", "\u0000\u0001", "{\"type\":\"response_item\",\"payload\":\"x\"}"];
  for (const fn of [M.classifyClaudeTail, M.classifyCodexTail]) {
    assert.doesNotThrow(() => fn(junk, { ageMs: MIN }));
    assert.doesNotThrow(() => fn(null));
    assert.doesNotThrow(() => fn([42, {}, undefined], { headLines: "nope" }));
  }
  assert.equal(M.classifyClaudeTail([...junk, cTool("t")], { ageMs: MIN }).reason, "approval pending");
});

test("Codex: an unanswered call waits, an answered one with a reply is your turn", () => {
  const pend = M.classifyCodexTail([xMeta("uuid-1"), xUser("add tests"), xCall("c1")], { ageMs: MIN });
  assert.deepEqual([pend.state, pend.reason, pend.cwd, pend.title, pend.sessionId], ["waiting", "approval pending", "/w/api", "add tests", "uuid-1"]);
  const done = M.classifyCodexTail([xUser("add tests"), xCall("c1"), xOut("c1"), xText("Added."), xDone()], { ageMs: 1000 });
  assert.deepEqual([done.state, done.reason], ["waiting", "your turn"]);   // task_complete ends the turn even while fresh
});

test("Codex: running while outputs land, idle once quiet; instruction wrappers are not the title", () => {
  const lines = [xUser("<environment_context>cwd</environment_context>"), xUser("real ask"), xCall("c1"), xOut("c1")];
  assert.equal(M.classifyCodexTail(lines, { ageMs: 3000 }).state, "running");
  assert.equal(M.classifyCodexTail(lines, { ageMs: 10 * MIN }).state, "idle");
  assert.equal(M.classifyCodexTail(lines).title, "real ask");
  assert.equal(M.classifyCodexTail([j({ type: "event_msg", payload: { type: "turn_aborted" } })], { ageMs: MIN }).reason, "interrupted");
  assert.equal(M.classifyCodexTail([j({ type: "turn_context", payload: { cwd: "/w/later" } })]).cwd, "/w/later");
});

/* ---- the scan, on a fake disk ---- */

function fakeDisk(files) {
  // files: { "/abs/path": { text, mtimeMs } }; directories are implied.
  const reads = [];
  const dirs = new Map();
  for (const p of Object.keys(files)) {
    let child = p;
    let dir = p.slice(0, p.lastIndexOf("/"));
    while (dir) {
      if (!dirs.has(dir)) dirs.set(dir, new Set());
      dirs.get(dir).add(child.slice(dir.length + 1));
      child = dir;
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }
  const deps = {
    readdir(dir) { if (!dirs.has(dir)) throw new Error("ENOENT " + dir); return [...dirs.get(dir)]; },
    stat(p) {
      if (files[p]) return { mtimeMs: files[p].mtimeMs, size: Buffer.byteLength(files[p].text), isFile: true, isDirectory: false };
      if (dirs.has(p)) return { mtimeMs: 0, size: 0, isFile: false, isDirectory: true };
      throw new Error("ENOENT " + p);
    },
    read(p, start, length) {
      reads.push({ p, start, length });
      return Buffer.from(files[p].text).subarray(start, start + length).toString("utf8");
    },
    write() { throw new Error("the scan must never write"); },
  };
  return { deps, reads };
}

const H = "/home/u";
const claudeFile = (slug, id) => join(H, ".claude", "projects", slug, id + ".jsonl");
const codexFile = (name) => join(H, ".codex", "sessions", "2026", "11", "18", name);

test("scan: both agents, newest first, the 24 h window, limit, handoff and resume ids", () => {
  const { deps } = fakeDisk({
    [claudeFile("-w-app", "11111111-aaaa-bbbb-cccc-000000000001")]: { text: [cUser("old one"), cText("ok")].join("\n"), mtimeMs: NOW - 25 * 60 * MIN },
    [claudeFile("-w-app", "11111111-aaaa-bbbb-cccc-000000000002")]: { text: [cUser("fix"), cTool("t")].join("\n"), mtimeMs: NOW - 2 * MIN },
    [codexFile("rollout-2026-11-18T10-00-00-22222222-aaaa-bbbb-cccc-000000000003.jsonl")]: {
      text: [xMeta("22222222-aaaa-bbbb-cccc-000000000003"), xUser("api"), xText("done"), xDone()].join("\n"), mtimeMs: NOW - MIN },
    [join(H, ".codex", "sessions", "notes.txt")]: { text: "x", mtimeMs: NOW },
    [join(H, ".claude", "projects", "-w-app", "memory", "a.md")]: { text: "x", mtimeMs: NOW },
  });
  const rows = M.scanAgentSessions({ home: H, env: {}, now: NOW, deps });
  assert.deepEqual(rows.map((r) => [r.agent, r.state, r.reason]), [["codex", "waiting", "your turn"], ["claude-code", "waiting", "approval pending"]]);
  assert.equal(rows[0].id, "2026-11-18T10-00-00-22222222-aaaa-bbbb-cccc-000000000003");   // what `atag handoff --session` takes
  assert.equal(rows[0].resumeId, "22222222-aaaa-bbbb-cccc-000000000003");
  assert.equal(rows[1].resumeId, rows[1].id);
  assert.equal(M.scanAgentSessions({ home: H, now: NOW, deps, limit: 1 }).length, 1);
  assert.equal(M.scanAgentSessions({ home: H, now: NOW, deps, maxAgeMs: 26 * 60 * MIN }).length, 3);
});

test("scan: CLAUDE_CODE_STATE_DIR / CODEX_STATE_DIR move the roots; missing roots are empty, not errors", () => {
  const { deps } = fakeDisk({ ["/alt/claude/projects/-p/abc.jsonl"]: { text: cUser("hi"), mtimeMs: NOW - MIN } });
  const rows = M.scanAgentSessions({ home: "/nobody", env: { CLAUDE_CODE_STATE_DIR: "/alt/claude", CODEX_STATE_DIR: "/alt/codex" }, now: NOW, deps });
  assert.deepEqual(rows.map((r) => r.id), ["abc"]);
  assert.deepEqual(M.scanAgentSessions({ home: "/nobody", now: NOW, deps }), []);
});

test("scan: a huge file is read only at its ends, the cut lines dropped", () => {
  const filler = cUser("x".repeat(200));
  const big = [cUser("first ask"), ...Array(60_000).fill(filler), cTool("last")].join("\n");   // ~13 MB
  const file = claudeFile("-w-big", "big");
  const { deps, reads } = fakeDisk({ [file]: { text: big, mtimeMs: NOW - MIN } });
  const [row] = M.scanAgentSessions({ home: H, now: NOW, deps });
  assert.equal(row.reason, "approval pending");
  assert.equal(row.title, "first ask");
  const total = reads.reduce((n, r) => n + r.length, 0);
  assert.ok(total <= M.HEAD_BYTES + M.TAIL_BYTES, "read " + total + " bytes");
  assert.ok(reads.some((r) => r.start === Buffer.byteLength(big) - M.TAIL_BYTES));
});

test("scan: an unreadable file is skipped, the rest still listed", () => {
  const { deps } = fakeDisk({
    [claudeFile("-w", "good")]: { text: cUser("ok"), mtimeMs: NOW - MIN },
    [claudeFile("-w", "bad")]: { text: cUser("ok"), mtimeMs: NOW - 2 * MIN },
  });
  const read = deps.read;
  deps.read = (p, s, l) => { if (p.includes("bad")) throw new Error("EACCES"); return read(p, s, l); };
  assert.deepEqual(M.scanAgentSessions({ home: H, now: NOW, deps }).map((r) => r.id), ["good"]);
});

/* ---- renderer pure half ---- */

test("renderer: groups in order, dots, resume commands, escaping", () => {
  const rows = [
    { agent: "codex", id: "r1", resumeId: "u1", state: "idle", reason: "finished", mtimeMs: 1, cwd: "/w/a", title: "t" },
    { agent: "claude-code", id: "c1", resumeId: "c1", state: "waiting", reason: "approval pending", mtimeMs: 3, cwd: "/w/b", title: "<img src=x onerror=1>" },
    { agent: "claude-code", id: "c2", resumeId: "c2", state: "running", reason: "working", mtimeMs: 2, cwd: null, title: null },
  ];
  assert.deepEqual(R.hubGroupRows(rows).map((g) => g.label), ["Waiting for you", "Running", "Recent"]);
  assert.equal(R.hubDotClass(rows[1]), "tk-dot tk-dot--amber");
  assert.equal(R.hubDotClass(rows[2]), "tk-dot tk-dot--brand tk-dot--pulse");
  assert.equal(R.hubDotClass(rows[0]), "tk-dot tk-dot--hollow");
  assert.equal(R.hubResumeCommand(rows[1]), "claude --resume c1");
  assert.equal(R.hubResumeCommand(rows[0]), "codex resume u1");
  assert.equal(R.hubResumeCommand({ agent: "codex", resumeId: "x; rm -rf ~" }), "");
  assert.equal(R.hubFolder("/Users/me/my-app/"), "my-app");
  const html = R.hubListHTML(rows, { rel: () => "now", terminalOk: true });
  assert.ok(!html.includes("<img"), "title escaped");
  assert.ok(html.includes("&lt;img src=x onerror=1&gt;"));
  assert.ok(html.includes('data-act="hub:go:claude-code:c1"'));
  assert.ok(html.includes('data-act="hub:term:codex:r1"'));
  assert.ok(!R.hubListHTML(rows, { terminalOk: false }).includes("hub:term:"), "no Terminal button where it is unsupported");
  assert.match(R.hubListHTML([], {}), /No Claude Code or Codex sessions/);
  assert.ok(R.hubRowHTML({ agent: "codex", id: 'a"b', state: "idle" }, {}).includes("a&quot;b"));
});

test("hooks: renderer.js palette, overlay and act; index.html; main.ts and preload", () => {
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.match(src, /\['chat','Agents: who is waiting for you','','','hub:open'\]/);
  assert.match(src, /if \(S\.overlay === 'hub'\) html \+= hubSheetHTML\(\);/);
  assert.match(src, /if \(k === 'hub'\) \{ if \(v === 'open'\) \{ close\(\); S\.settings = null; \} hubAct\(v \|\| ''\); render\(\); return; \}/);
  assert.ok(!/^const AG_HUB\b/m.test(src), "the sheet's state lives in agent-hub.js (renderer.js has its own HUB)");
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('src="agent-hub.js"') > html.indexOf('src="handoff.js"'));
  assert.ok(html.indexOf('src="agent-hub.js"') < html.indexOf('src="renderer.js"'));
  assert.ok(html.includes('href="css/agent-hub.css"'));
  assert.ok(readFileSync(new URL("../renderer/handoff.js", import.meta.url), "utf8").includes('data-act="hub:open"'));
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.match(main, /import \{ wireAgentHubIpc \} from "\.\/agent-hub-ipc\.js";/);
  assert.match(main, /wireAgentHubIpc\(\{ isRemote: \(\) => client\.isRemote \}\);/);
  const pre = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.match(pre, /hubScan: \(\) => ipcRenderer\.invoke\("hub:scan"\)/);
  const ipc = readFileSync(new URL("../main/agent-hub-ipc.ts", import.meta.url), "utf8");
  assert.match(ipc, /if \(opts\.isRemote\(\)\) return \{ ok: false, reason: "remote"/);
  assert.ok(!/writeFileSync|mkdirSync|rmSync|unlinkSync|renameSync/.test(ipc), "read-only");
});
