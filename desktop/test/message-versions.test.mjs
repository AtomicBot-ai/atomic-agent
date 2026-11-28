// ATO-2470: "‹ 2/3 ›" on edited messages, on answers to any question and on a
// failed Regenerate. main/message-versions.ts is checked against the built
// output (npm run build first); the pure half of renderer/message-versions.js
// is loaded as a CommonJS module; msgActs and sysRowHTML are lifted out of
// renderer.js and run in a vm context (as answer-versions.test.mjs does); the
// IPC wiring is read from the sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const M = require("../out/main/message-versions.js");
const R = require("../renderer/message-versions.js");
const ts = require("typescript");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const rendererSource = src("../renderer/renderer.js");
const ast = ts.createSourceFile("renderer.js", rendererSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map((n) => [n.name.text, n.getText(ast)]));

/* ---------- main: what may be sent, and the agent's answers ---------- */

test("a switch names a position and a ref from the listing, nothing else", () => {
  assert.deepEqual(M.switchVersionBody(1, "B2", "b0"), { priorQuestions: 1, expectText: "B2", ref: "b0" });
  assert.deepEqual(M.switchVersionBody(0, undefined, "r3"), { priorQuestions: 0, ref: "r3" });
  for (const [p, ref] of [[-1, "b0"], [1.5, "b0"], ["1", "b0"], [0, "x1"], [0, "b"], [0, 3]]) assert.equal(M.switchVersionBody(p, "t", ref), null, `${p} ${ref}`);
});

test("the listing is read into questions with their versions; junk is dropped", () => {
  const r = M.messageVersionsAnswer(200, {
    id: "s-1",
    questions: [
      { priorQuestions: 1, live: { text: "B2", at: 5, answerAt: 6 }, versions: [{ ref: "b0", text: "B", at: 3, answerAt: 4, keptAt: 50 }, { ref: "zz", text: "x" }], compacted: false },
      { priorQuestions: 2, live: null, versions: [] },
      "junk",
    ],
  });
  assert.deepEqual(r, { ok: true, supported: true, questions: [
    { priorQuestions: 1, live: { text: "B2", at: 5, answerAt: 6 }, versions: [{ ref: "b0", text: "B", at: 3, answerAt: 4, keptAt: 50 }], compacted: false },
  ] });
});

test("an unknown chat, an agent without the routes and a refusal read apart", () => {
  assert.equal(M.messageVersionsAnswer(404, { error: { message: "session not found: s", code: "session_not_found" } }).code, "session_not_found");
  assert.equal(M.messageVersionsAnswer(404, { error: { message: "not found" } }).supported, false);
  const refused = M.switchVersionAnswer(409, { error: { message: "nope", code: "point_mismatch" } });
  assert.deepEqual(refused, { ok: false, supported: true, code: "point_mismatch", error: "nope" });
  assert.deepEqual(M.switchVersionAnswer(200, { id: "s", text: "B", versions: 1 }), { ok: true, supported: true, text: "B", versions: 1 });
});

/* ---------- renderer: the views ---------- */

const edited = { priorQuestions: 1, live: { text: "B2", at: 5, answerAt: 6 }, versions: [{ ref: "b0", text: "B", at: 3, answerAt: 4, keptAt: 50 }], compacted: false };

test("an edited message shows its texts oldest first, the one on screen last, and steps to the kept one", () => {
  const view = R.mverEditView(edited, "B2");
  assert.equal(view.total, 2);
  assert.equal(view.pos, 2);
  assert.equal(R.mverStep(view, -1), "b0");
  assert.equal(R.mverStep(view, 1), null);
  assert.equal(R.mverAnswerView(edited, "B2"), null, "no other answer to B2");
});

test("two edits back to the same text are one version, the newest kept one is the one put back", () => {
  const q = { ...edited, versions: [...edited.versions, { ref: "b1", text: "B ", at: 7, answerAt: 8, keptAt: 90 }] };
  const view = R.mverEditView(q, "B2");
  assert.equal(view.total, 2);
  assert.equal(R.mverStep(view, -1), "b1");
});

test("answers kept by Regenerate are versions under the answer, by when each was written", () => {
  const q = { priorQuestions: 0, live: { text: "A", at: 1, answerAt: 40 }, versions: [{ ref: "b0", text: "A", at: 1, answerAt: 2, keptAt: 30 }, { ref: "r0", text: "A", at: 1, answerAt: 50, keptAt: 60 }], compacted: false };
  const view = R.mverAnswerView(q, "A");
  assert.deepEqual([view.pos, view.total], [2, 3]);
  assert.equal(R.mverStep(view, -1), "b0");
  assert.equal(R.mverStep(view, 1), "r0");
  assert.equal(R.mverEditView(q, "A"), null, "one text: no switcher on the message");
});

test("a failed try with no stored question is the newest version", () => {
  const q = { priorQuestions: 0, live: null, versions: [{ ref: "r0", text: "A", at: 1, answerAt: 2, keptAt: 3 }], compacted: false };
  const view = R.mverAnswerView(q, "A");
  assert.deepEqual([view.pos, view.total], [2, 2]);
  assert.equal(R.mverStep(view, -1), "r0");
});

test("the answer row is the turn's last answer; the failure row needs no answer after its question", () => {
  const q = { id: "u1", k: "user", text: "A" };
  const a1 = { id: "a1", k: "assistant", text: "part" };
  const a2 = { id: "a2", k: "assistant", text: "rest" };
  const q2 = { id: "u2", k: "user", text: "B" };
  const err = { id: "e1", k: "sys", sev: "err", text: "failed" };
  assert.equal(R.mverAnswerQuestion([q, a1, a2, q2], a1), null);
  assert.equal(R.mverAnswerQuestion([q, a1, a2, q2], a2), q);
  assert.equal(R.mverFailQuestion([q, a1, q2, err], err), q2);
  assert.equal(R.mverFailQuestion([q, a1, err], err), null, "an answer is on screen");
  assert.equal(R.mverFailQuestion([q2, err, q], err), null, "not the last question");
});

test("the refusal words are plain and never the agent's raw text for a known code", () => {
  assert.match(R.mverRefusalText({ code: "point_mismatch", error: "raw" }), /changed since/);
  assert.match(R.mverRefusalText({ code: "point_compacted" }), /summarized/);
});

/* ---------- renderer.js: where the switchers are drawn ---------- */

function rendererContext(log, data) {
  const c = vm.createContext({
    S: { log, busy: false, pending: null, agentSession: "s-1", streamId: null },
    ROLLBACK: { cleared: { sid: null, n: 0 } },
    BR: { messageVersions: async () => data, switchMessageVersion: async () => ({ ok: true, supported: true }) },
    esc: (s) => String(s), ic: (n) => "<i:" + n + ">", render() {}, toast() {}, openSession: async () => {},
    replyRetryAsk: () => null, replyTurnActed: () => false, ACTED_RETRY_HINT: "", BUSY_RETRY_HINT: "",
    sysGlyph: () => "", deadEngineOffer: () => ({ kind: "" }), DWATCH: null, sysRetryHTML: () => "",
  });
  vm.runInContext(src("../renderer/answer-versions.js").replace(/^const AVER/m, "var AVER"), c);
  vm.runInContext(src("../renderer/message-versions.js").replace(/^const MVER/m, "var MVER").replace(/^const mverNorm/m, "var mverNorm"), c);
  for (const name of ["isLastReply", "msgActs", "priorQuestions", "sysRowHTML"]) {
    assert.ok(functions.has(name), name);
    vm.runInContext(functions.get(name), c);
  }
  return c;
}

test("msgActs draws ‹ 2/2 › on an edited message once the versions are in, and the old last-answer switcher steps aside", async () => {
  const a = { id: "u0", k: "user", text: "A" };
  const ra = { id: "a0", k: "assistant", text: "a" };
  const b = { id: "u1", k: "user", text: "B2" };
  const rb = { id: "a1", k: "assistant", text: "b2" };
  const c = rendererContext([a, ra, b, rb], { ok: true, supported: true, questions: [edited] });
  assert.doesNotMatch(c.msgActs(b), /data-mver/, "first draw: still being asked for");
  await new Promise((done) => setImmediate(done));
  const row = c.msgActs(b);
  assert.match(row, /data-mver="prev" data-mver-kind="edit" data-mver-q="1"/);
  assert.match(row, />2\/2</);
  assert.doesNotMatch(c.msgActs(a), /data-mver/, "a message with one version has none");
  assert.doesNotMatch(c.msgActs(rb), /data-ver=/, "answer-versions.js draws nothing while this file is in charge");
});

test("a failed Regenerate's row carries the answer switcher", async () => {
  const q = { id: "u0", k: "user", text: "A" };
  const err = { id: "e0", k: "sys", sev: "err", text: "The model did not answer." };
  const data = { ok: true, supported: true, questions: [{ priorQuestions: 0, live: null, versions: [{ ref: "r0", text: "A", at: 1, answerAt: 2, keptAt: 3 }], compacted: false }] };
  const c = rendererContext([q, err], data);
  c.sysRowHTML(err, 1);
  await new Promise((done) => setImmediate(done));
  const row = c.sysRowHTML(err, 1);
  assert.match(row, /data-mver-kind="answer" data-mver-q="0"/);
  assert.match(row, />2\/2</);
});

test("the wiring: preload, IPC routes, script tag before renderer.js, the hooks", () => {
  const preload = src("../preload/preload.ts");
  for (const ch of ["agent:messageVersions", "agent:switchVersion"]) assert.ok(preload.includes(`"${ch}"`), ch);
  const ipc = src("../main/answer-versions-ipc.ts");
  for (const s of ['"agent:messageVersions"', '"agent:switchVersion"', '"message-versions"', '"switch-version"']) assert.ok(ipc.includes(s), s);
  assert.match(src("../renderer/index.html"), /<script src="message-versions.js"><\/script>\s*\n(?:.*\n)*<script src="renderer.js"><\/script>/);
  assert.match(src("../renderer/index.html"), /css\/message-versions.css/);
  assert.match(rendererSource, /messageVersionsUserHTML\(m\)/);
  assert.match(rendererSource, /messageVersionsAnswerHTML\(m\)/);
  assert.match(rendererSource, /messageVersionsFailHTML\(m\)/);
  assert.match(src("../renderer/chat-rewind.js"), /BR\.rewind\(sid, REWIND\.prior, REWIND\.text, files, undefined, edit\)/);
});
