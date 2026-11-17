// ATO-1502: the desktop's card for the agent's ask_user question.
// The pure half of renderer/question-card.js, plus the wiring read from the
// sources (renderer.js, index.html, main, preload, agent-client).
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Q = require("../renderer/question-card.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const h = { esc, ic: (n) => '<i data-ic="' + n + '"></i>', keyLabel: (w) => (w === "y" ? "⌘↩" : "⌘.") };

const RAW = {
  prompt: "Which database?",
  options: [
    { label: "Postgres", description: "a server" },
    { label: "SQLite" },
    { label: "SQLite" },
    { label: "  " },
  ],
  multiSelect: false,
  allowOther: true,
};

/* ---------- the question ---------- */

test("qcQuestion keeps the prompt and the options, drops blanks and repeats", () => {
  const q = Q.qcQuestion(RAW);
  assert.equal(q.prompt, "Which database?");
  assert.deepEqual(q.options.map((o) => o.label), ["Postgres", "SQLite"]);
  assert.equal(q.options[0].description, "a server");
  assert.equal(q.multiSelect, false);
  assert.equal(q.allowOther, true);
});

test("qcQuestion: nothing to draw is null", () => {
  assert.equal(Q.qcQuestion(null), null);
  assert.equal(Q.qcQuestion({ options: [{ label: "a" }] }), null, "no prompt");
  assert.equal(Q.qcQuestion({ prompt: "x", options: "a,b" }), null);
  assert.equal(Q.qcQuestion({ prompt: "x", options: [] }), null, "no options and no own answer");
  assert.ok(Q.qcQuestion({ prompt: "x", options: [], allowOther: true }), "own words only is still a question");
});

test("qcQuestion caps the options at eight", () => {
  const q = Q.qcQuestion({ prompt: "x", options: Array.from({ length: 12 }, (_, i) => ({ label: "o" + i })) });
  assert.equal(q.options.length, Q.QC_MAX_OPTIONS);
});

/* ---------- the answer, as the agent will check it ---------- */

test("qcAnswer: one pick, own words, both", () => {
  const q = Q.qcQuestion(RAW);
  assert.deepEqual(Q.qcAnswer(q, ["SQLite"], ""), { selected: ["SQLite"] });
  assert.deepEqual(Q.qcAnswer(q, [], "  MySQL "), { selected: [], other: "MySQL" });
  assert.deepEqual(Q.qcAnswer(q, ["Postgres"], "with pgvector"), { selected: ["Postgres"], other: "with pgvector" });
});

test("qcAnswer refuses what the agent would refuse", () => {
  const q = Q.qcQuestion(RAW);
  assert.equal(typeof Q.qcAnswer(q, [], ""), "string", "nothing picked");
  assert.equal(typeof Q.qcAnswer(q, ["Postgres", "SQLite"], ""), "string", "two picks on a one-pick question");
  const closed = Q.qcQuestion({ ...RAW, allowOther: false });
  assert.equal(typeof Q.qcAnswer(closed, [], "mine"), "string", "own words where none are taken");
  assert.deepEqual(Q.qcAnswer(closed, ["Nope", "SQLite"], ""), { selected: ["SQLite"] }, "an option it never offered is dropped");
});

test("qcAnswer on a multi-pick question keeps the question's order", () => {
  const q = Q.qcQuestion({ prompt: "x", options: [{ label: "a" }, { label: "b" }, { label: "c" }], multiSelect: true });
  assert.deepEqual(Q.qcAnswer(q, ["c", "a"], ""), { selected: ["a", "c"] });
});

test("qcAnswer caps own words at the agent's limit", () => {
  const q = Q.qcQuestion({ prompt: "x", options: [], allowOther: true });
  assert.equal(Q.qcAnswer(q, [], "x".repeat(5000)).other.length, Q.QC_OTHER_MAX);
});

/* ---------- the card ---------- */

const row = (extra = {}) => ({ k: "approval", approvalId: "ap1", question: Q.qcQuestion(RAW), ...extra });

test("an open card: the prompt, one row per option, the own-answer field, Send and Skip, no Allow", () => {
  const html = Q.qcCardHTML(row(), h, true);
  assert.match(html, /class="appr qc" id="apprcard" tabindex="-1" data-appr-id="ap1"/);
  assert.match(html, /Which database\?/);
  assert.equal((html.match(/data-qc="pick"/g) || []).length, 2);
  assert.match(html, /role="radio"/);
  assert.match(html, /data-qc-other/);
  assert.match(html, /data-qc="send" disabled/, "Send waits for a pick");
  assert.match(html, /data-qc="skip"/);
  assert.match(html, /data-appr="esc"/, "Abort run stays");
  assert.doesNotMatch(html, /data-appr="y"/, "no Allow once on a question");
  assert.match(html, /⌘↩/, "the card the keys answer names them");
});

test("a picked option is marked and Send is live; several picks use checkboxes", () => {
  assert.match(Q.qcCardHTML(row({ qcPick: ["SQLite"] }), h, false), /class="qc-opt on"[^>]*data-qc-i="1"[^>]*aria-checked="true"/);
  assert.doesNotMatch(Q.qcCardHTML(row({ qcPick: ["SQLite"] }), h, false), /data-qc="send" disabled/);
  const multi = { ...row(), question: Q.qcQuestion({ ...RAW, multiSelect: true }) };
  assert.match(Q.qcCardHTML(multi, h, false), /role="checkbox"/);
});

test("a one-pick question without own words has no Send: a click on an option answers", () => {
  const html = Q.qcCardHTML({ ...row(), question: Q.qcQuestion({ ...RAW, allowOther: false }) }, h, false);
  assert.doesNotMatch(html, /data-qc="send"/);
  assert.doesNotMatch(html, /data-qc-other/);
});

test("the question's words are escaped", () => {
  const html = Q.qcCardHTML({ ...row(), question: Q.qcQuestion({ prompt: "<img src=x>", options: [{ label: "<b>a</b>" }, { label: "b" }] }) }, h, false);
  assert.doesNotMatch(html, /<img src=x>|<b>a<\/b>/);
});

test("the receipt: Answered with what was sent, Skipped, or not answered", () => {
  const done = Q.qcCardHTML(row({ state: "answered", at: "14:32:09", qcSent: { selected: ["Postgres"], other: "v16" } }), h, false);
  assert.match(done, /class="appr done qc-done ok"/);
  assert.match(done, /<b>Answered<\/b> by you · <span class="mono">14:32:09<\/span>/);
  assert.match(done, /Postgres, “v16”/);
  assert.match(Q.qcCardHTML(row({ state: "skipped", at: "1" }), h, false), /<b>Skipped<\/b> by you/);
  assert.match(Q.qcCardHTML(row({ state: "stopped", at: "1" }), h, false), /the run was stopped/);
  assert.match(Q.qcCardHTML(row({ state: "expired", at: "1" }), h, false), /stopped waiting/);
});

/* ---------- wiring, read from the sources ---------- */

test("renderer.js keeps the question on the request, draws its card and routes its keys", () => {
  const r = src("../renderer/renderer.js");
  assert.match(r, /question: payload\.category === 'user_question' && typeof qcQuestion === 'function' \? qcQuestion\(payload\.question\) : null,/);
  assert.match(r, /function apprCard\(m\) \{\n  \/\/ ATO-1502[^\n]*\n  if \(m\.question && typeof qcCardHTML === 'function'\) return qcCardHTML\(m, \{esc, ic, keyLabel: apprKeyLabel\}, m === S\.pending\);/);
  assert.match(r, /function answerLive\(req, key\) \{\n  \/\/ ATO-1502[^\n]*\n  if \(req && req\.question && key !== 'esc' && typeof qcKey === 'function'\) \{ qcKey\(req, key\); return; \}/);
});

test("the page loads question-card.js before renderer.js, and its stylesheet", () => {
  const index = src("../renderer/index.html");
  const at = (s) => index.indexOf(s);
  assert.ok(at('<script src="question-card.js">') > 0);
  assert.ok(at('<script src="question-card.js">') < at('<script src="renderer.js">'));
  assert.ok(at('href="css/question-card.css"') > 0);
});

test("the answer goes to POST /api/question/answer through its own route, never /api/approval/resolve", () => {
  const card = src("../renderer/question-card.js");
  assert.match(card, /BR\.answerQuestion\(Object\.assign\(\{approvalId: req\.approvalId\}, body\)\)/);
  assert.doesNotMatch(card, /BR\.approve\(/);
  const pre = src("../preload/preload.ts");
  assert.match(pre, /answerQuestion: \(req: \{ approvalId: string; selected\?: string\[\]; other\?: string; skip\?: boolean \}\) =>\n    ipcRenderer\.invoke\("agent:answerQuestion", req\)/);
  const main = src("../main/main.ts");
  assert.match(main, /ipcMain\.handle\("agent:answerQuestion",/);
  assert.match(main, /client\.answerQuestion\(p\.approvalId, answer\)/);
  const client = src("../main/agent-client.ts");
  assert.match(client, /fetch\(`\$\{this\.base\(\)\}\/api\/question\/answer`/);
});

test("the desktop's turns say it can show the card (x-atomic-questions: 1)", () => {
  const client = src("../main/agent-client.ts");
  const at = client.indexOf("/v1/chat/completions`, {");
  assert.ok(at > 0);
  assert.match(client.slice(at, at + 1200), /"x-atomic-questions": "1",/);
});

test("the mini chat says a question is waiting, for the big window", () => {
  const R = require("../renderer/mini-chat.js");
  const st = R.mcState();
  R.mcSend(st, "hi");
  st.sessionId = "s1";
  assert.equal(R.mcApproval(st, { approvalId: "q1", sessionId: "s1", tool: "ask_user", category: "user_question" }), true);
  assert.match(R.mcApprovalLine(st.approval), /question/);
});
