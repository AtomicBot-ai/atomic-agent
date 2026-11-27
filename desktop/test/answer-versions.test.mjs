// ATO-2114: "‹ 2/3 ›" under the last reply, for the answers Regenerate kept.
// main/answer-versions.ts is checked against the built output (npm run build
// first); the pure half of renderer/answer-versions.js is loaded as a CommonJS
// module; msgActs and sessionTurnsToLog are lifted out of renderer.js and run
// in a vm context (as exa-key.test.mjs does); the IPC wiring is read from the sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const M = require("../out/main/answer-versions.js");
const R = require("../renderer/answer-versions.js");
const ts = require("typescript");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const rendererSource = src("../renderer/renderer.js");
const ast = ts.createSourceFile("renderer.js", rendererSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map((n) => [n.name.text, n.getText(ast)]));

/* ---------- main: what may be sent, and the agent's answers ---------- */

test("a restore names a whole non-negative index and nothing else", () => {
  assert.deepEqual(M.restoreReplyBody(0), { index: 0 });
  assert.deepEqual(M.restoreReplyBody(3), { index: 3 });
  for (const bad of [-1, 1.5, "1", null, undefined, NaN]) assert.equal(M.restoreReplyBody(bad), null, String(bad));
});

test("the kept answers are read as index and time only; the texts stay in the agent", () => {
  const r = M.previousRepliesAnswer(200, {
    id: "s-1", question: "why?", questionStored: true,
    previous: [{ index: 0, text: "old", at: 100, replacedAt: 150 }, { index: 1, text: "older?", at: 120 }, { index: -1, at: 5 }, "junk"],
  });
  assert.deepEqual(r, { ok: true, supported: true, question: "why?", questionStored: true, previous: [{ index: 0, at: 100 }, { index: 1, at: 120 }] });
  assert.deepEqual(M.previousRepliesAnswer(200, { id: "s-1", question: null, questionStored: false, previous: [] }),
    { ok: true, supported: true, question: null, questionStored: false, previous: [] });
});

test("an unknown chat, an agent without the routes and a refusal read apart", () => {
  assert.equal(M.previousRepliesAnswer(404, { error: { message: "session not found: s", code: "session_not_found" } }).code, "session_not_found");
  assert.equal(M.previousRepliesAnswer(404, { error: { message: "no route" } }).supported, false);
  assert.equal(M.restoreReplyAnswer(404, null).supported, false);
  assert.deepEqual(M.restoreReplyAnswer(409, { error: { message: "busy", code: "turn_in_progress" } }),
    { ok: false, supported: true, code: "turn_in_progress", error: "busy" });
  assert.deepEqual(M.restoreReplyAnswer(200, { id: "s", text: "old", previousReplies: 2 }), { ok: true, supported: true, previousReplies: 2 });
  assert.equal(M.restoreReplyAnswer(500, null).error, "HTTP 500");
});

/* ---------- renderer: which reply, the order, the steps ---------- */

test("only the reply to the chat's last question gets a switcher", () => {
  const q0 = { id: "u0", k: "user", text: "first" };
  const a0 = { id: "a0", k: "assistant", text: "one" };
  const q1 = { id: "u1", k: "user", text: "second" };
  const steer = { id: "u2", k: "user", text: "and this", steered: true };
  const a1 = { id: "a1", k: "assistant", text: "two" };
  assert.equal(R.answerVersionsQuestion([q0, a0, q1, steer, a1], a1), q1);
  assert.equal(R.answerVersionsQuestion([q0, a0, q1], a0), null, "a later question follows it");
  assert.equal(R.answerVersionsQuestion([q0, a0], q0), null);
  assert.equal(R.answerVersionsQuestion([a0], a0), null);
});

test("versions run oldest first by when they were written; the one on screen keeps its place", () => {
  const kept = [{ index: 0, at: 300 }, { index: 1, at: 100 }];
  // A reply streamed in this window (no time yet) is the newest.
  const fresh = R.answerVersionsOrder(kept, undefined);
  assert.deepEqual([fresh.pos, fresh.total], [3, 3]);
  // The oldest answer put back: first of three, whatever order the agent lists them in.
  const restored = R.answerVersionsOrder([{ index: 0, at: 300 }, { index: 1, at: 200 }], 100);
  assert.deepEqual([restored.pos, restored.total], [1, 3]);
  assert.deepEqual(restored.list.map((v) => v.index), [null, 1, 0]);
  assert.equal(R.answerVersionsStep(restored, -1), null, "nothing before the first");
  assert.equal(R.answerVersionsStep(restored, 1), 1);
  assert.equal(R.answerVersionsStep(fresh, 1), null, "nothing after the last");
  assert.equal(R.answerVersionsStep(fresh, -1), 0);
});

test("no switcher without kept answers, for another question, or when the question is not stored", () => {
  const data = { ok: true, question: "why?", questionStored: true, previous: [{ index: 0, at: 1 }] };
  assert.deepEqual(R.answerVersionsView(data, " why? ", 5).total, 2);
  assert.equal(R.answerVersionsView({ ...data, previous: [] }, "why?", 5), null);
  assert.equal(R.answerVersionsView(data, "how?", 5), null);
  assert.equal(R.answerVersionsView({ ...data, questionStored: false }, "why?", 5), null);
  assert.equal(R.answerVersionsView(null, "why?", 5), null);
});

test("the switcher reads 2/3 with both arrows, disabled at the ends and while a swap runs", () => {
  const html = R.answerVersionsSwitchHTML({ pos: 1, total: 3, list: [] }, false);
  assert.match(html, />1\/3</);
  assert.match(html, /data-ver="prev"[^>]* disabled/);
  assert.doesNotMatch(html, /data-ver="next"[^>]* disabled/);
  assert.match(R.answerVersionsSwitchHTML({ pos: 2, total: 3, list: [] }, true), /data-ver="next"[^>]* disabled/);
  assert.doesNotMatch(html, /—/, "no long dash in UI text");
  assert.doesNotMatch(R.answerVersionsRefusalText({ code: "turn_has_tools" }), /—/);
});

/* ---------- renderer.js: the reply row carries the switcher, a reopened reply its time ---------- */

function rendererContext(log, data) {
  const c = vm.createContext({
    S: { log, busy: false, pending: null, agentSession: "s-1", streamId: null },
    BR: { previousReplies: async () => data },
    esc: (s) => String(s), ic: (n) => "<i:" + n + ">", render() {}, toast() {}, openSession: async () => {},
    replyRetryAsk: () => null, replyTurnActed: () => false, ACTED_RETRY_HINT: "", BUSY_RETRY_HINT: "",
    nid: (() => { let i = 0; return () => "n" + (++i); })(), replyFilesOf: () => [], revalidateChatImages() {},
  });
  vm.runInContext(src("../renderer/answer-versions.js").replace(/^const AVER/m, "var AVER"), c);
  for (const name of ["isLastReply", "msgActs", "sessionTurnsToLog"]) {
    assert.ok(functions.has(name), name);
    vm.runInContext(functions.get(name), c);
  }
  return c;
}

test("a reopened reply keeps its stored time, which orders the versions", () => {
  const c = rendererContext([], null);
  const log = c.sessionTurnsToLog([{ kind: "user", text: "why?", at: 1 }, { kind: "assistant_reply", text: "because", at: 42 }]);
  assert.equal(log[1].storedAt, 42);
});

test("msgActs puts the switcher first in the last reply's row once the kept answers are in", async () => {
  const q = { id: "u1", k: "user", text: "why?" };
  const a = { id: "a1", k: "assistant", text: "because", storedAt: 50 };
  const c = rendererContext([q, a], { ok: true, supported: true, question: "why?", questionStored: true, previous: [{ index: 0, at: 10 }] });
  assert.doesNotMatch(c.msgActs(a), /data-ver/, "first draw: the kept answers are still being asked for");
  await new Promise((done) => setImmediate(done));
  const row = c.msgActs(a);
  assert.match(row, /^<div class="msgacts msgacts-last"><span class="ansver"/);
  assert.match(row, />2\/2</);
  assert.doesNotMatch(c.msgActs(q), /data-ver/, "never on a question");
});

test("the restore route is wired from preload through main", () => {
  const ipc = src("../main/answer-versions-ipc.ts");
  assert.match(ipc, /"agent:previousReplies"[\s\S]*"previous-replies", "GET"/);
  assert.match(ipc, /"agent:restorePreviousReply"[\s\S]*"restore-previous-reply", "POST"/);
  assert.match(src("../main/main.ts"), /wireAnswerVersionsIpc\(client\)/);
  const preload = src("../preload/preload.ts");
  assert.match(preload, /previousReplies: \(sessionId: string\) => ipcRenderer\.invoke\("agent:previousReplies"/);
  assert.match(preload, /ipcRenderer\.invoke\("agent:restorePreviousReply", \{ sessionId, index \}\)/);
  const html = src("../renderer/index.html");
  assert.ok(html.indexOf('<script src="answer-versions.js">') > 0 && html.indexOf('<script src="answer-versions.js">') < html.indexOf('<script src="renderer.js">'));
  assert.match(html, /href="css\/answer-versions\.css"/);
});
