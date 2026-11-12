// ATO-1299 / ATO-1300 / ATO-1301: "Regenerate" under the last reply and a
// failed turn's "Try again" first ask the agent to take the last turn back
// (POST /api/sessions/{id}/rollback-last-turn), then send the question again.
//
// The client half runs against the built output (npm run build first); the
// window half reads renderer.js as text and runs regenerateReply in a vm
// context with its neighbours stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { AgentClient } = require("../out/main/agent-client.js");

async function standIn(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const [status, json] = answer(req);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new AgentClient(process.cwd());
  client.port = server.address().port;
  client.token = "t0ken";
  return { client, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("a rollback hands back the removed question", async () => {
  const s = await standIn(() => [200, { id: "ses/1", text: "What is 2+2?" }]);
  try {
    const r = await s.client.rollbackLastTurn("ses/1");
    assert.deepEqual(r, { ok: true, supported: true, text: "What is 2+2?" });
    assert.equal(s.seen[0].method, "POST");
    assert.equal(s.seen[0].url, "/api/sessions/ses%2F1/rollback-last-turn");
    assert.equal(s.seen[0].auth, "Bearer t0ken");
    assert.equal(s.seen[0].body, "{}");
  } finally { await s.close(); }
});

test("a question shown without an answer goes along as expectUnanswered (ATO-1420)", async () => {
  const s = await standIn(() => [409, { error: { message: "not that one", code: "turn_mismatch" } }]);
  try {
    await s.client.rollbackLastTurn("s1", "continue", 2, true);
    assert.equal(s.seen[0].body, JSON.stringify({ expectText: "continue", expectPriorQuestions: 2, expectUnanswered: true }));
    await s.client.rollbackLastTurn("s1", "continue", 2, false);
    assert.equal(s.seen[1].body, JSON.stringify({ expectText: "continue", expectPriorQuestions: 2 }));
  } finally { await s.close(); }
});

test("the question on screen goes along as expectText", async () => {
  const s = await standIn(() => [409, { error: { message: "not that one", code: "turn_mismatch" } }]);
  try {
    const r = await s.client.rollbackLastTurn("s1", "What is 2+2?", 3);
    assert.equal(s.seen[0].body, JSON.stringify({ expectText: "What is 2+2?", expectPriorQuestions: 3 }));
    assert.deepEqual(r, { ok: false, supported: true, code: "turn_mismatch", error: "not that one" });
  } finally { await s.close(); }
});

test("a 409 is the agent refusing, with its code", async () => {
  const s = await standIn(() => [409, { error: { message: "the last turn ran tools", code: "turn_has_tools" } }]);
  try {
    const r = await s.client.rollbackLastTurn("s1");
    assert.deepEqual(r, { ok: false, supported: true, code: "turn_has_tools", error: "the last turn ran tools" });
  } finally { await s.close(); }
});

test("the route's 404 is an unknown chat; the server's is an agent without the route", async () => {
  const known = await standIn(() => [404, { error: { message: "session not found: s1", code: "session_not_found" } }]);
  try {
    const r = await known.client.rollbackLastTurn("s1");
    assert.equal(r.supported, true);
    assert.equal(r.ok, false);
    assert.equal(r.code, "session_not_found");
  } finally { await known.close(); }
  const byMessage = await standIn(() => [404, { error: { message: "session not found: s1", code: null } }]);
  try {
    const r = await byMessage.client.rollbackLastTurn("s1");
    assert.equal(r.supported, true);
  } finally { await byMessage.close(); }
  const old = await standIn(() => [404, { error: { message: "No route for POST /api/sessions/s1/rollback-last-turn", code: null } }]);
  try {
    const r = await old.client.rollbackLastTurn("s1");
    assert.equal(r.supported, false);
    assert.equal(r.ok, false);
  } finally { await old.close(); }
});

test("an agent that is gone is a failure, not unsupported", async () => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const client = new AgentClient(process.cwd());
  client.port = port;
  client.token = "t0ken";
  const r = await client.rollbackLastTurn("s1");
  assert.equal(r.ok, false);
  assert.equal(r.supported, true);
});

/* ---------------- the window ---------------- */

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
function block(head) {
  const at = source.indexOf("\n" + head);
  assert.ok(at >= 0, head + " is top-level in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 3);
}
function constLine(name) {
  const at = source.indexOf("\nconst " + name + " = ");
  assert.ok(at >= 0, name + " is a top-level const in renderer.js");
  return source.slice(at + 1, source.indexOf("\n", at + 1) + 1);
}

function windowWith({ log, answer, busy = false, draft = "", voice = "idle", sid = "ses-1" }) {
  const calls = { rollback: [], resend: [], submit: [], toasts: [], opened: [] };
  const entry = { value: draft, focus() {}, setSelectionRange() {} };
  const c = vm.createContext({
    S: { log, busy, pending: null, draft, agentSession: sid, stick: false },
    RUNNING: new Map(),
    VOICE: { state: voice },
    ATT: { items: [] },
    ANX: { messageAction() {} },
    BR: { rollbackLastTurn: async (id, expectText, prior, unanswered) => { calls.rollback.push(id); calls.expect = expectText; calls.prior = prior; calls.unanswered = unanswered; return typeof answer === "function" ? answer(expectText, prior, unanswered) : answer; } },
    $: () => entry,
    toast: (t, s) => calls.toasts.push([t, s]),
    attSplitMessage: () => null,
    attToEditor: (t) => t,
    autosize() {},
    refreshSend() {},
    ctxDraftChanged() {},
    openSession: async (id) => { calls.opened.push(id); },
    resendUser: (id) => calls.resend.push(id),
    calls,
    entry,
  });
  vm.runInContext(
    constLine("ROLLBACK") + block("function rollbackStashBack(") + block("function rollbackNoteCleared(") + block("function priorQuestions(") + block("function rollbackRefusalText(") + block("async function regenerateReply(")
      + "globalThis.regenerateReply = regenerateReply; globalThis.ROLLBACK = ROLLBACK; globalThis.rollbackNoteCleared = rollbackNoteCleared;"
      + "globalThis.submit = () => calls.submit.push(S.draft);",
    c,
  );
  return c;
}

const plain = () => [
  { id: "q0", k: "user", text: "Hi" }, { id: "a0", k: "assistant", text: "Hello" },
  { id: "q1", k: "user", text: "Tell me a joke" }, { id: "a1", k: "assistant", text: "Knock knock" },
];

test("Regenerate takes the turn back, drops its rows in place and sends the question again", async () => {
  const log = plain();
  const w = windowWith({ log, answer: { ok: true, supported: true, text: "Tell me a joke" } });
  await w.regenerateReply("q1", false);
  assert.deepEqual(w.calls.rollback, ["ses-1"]);
  assert.equal(w.calls.expect, "Tell me a joke", "the question on screen is sent for the agent to match");
  assert.equal(w.calls.prior, 1, "and its position: one question before it");
  assert.equal(w.S.log, log, "the same array, so the transcript window keeps its place");
  assert.deepEqual(log.map((x) => x.id), ["q0", "a0"]);
  assert.deepEqual(w.calls.submit, ["Tell me a joke"]);
  assert.equal(w.entry.value, "Tell me a joke");
  assert.deepEqual(w.calls.resend, []);
});

test("an agent without the route falls back to the old resend, and remembers it", async () => {
  const w = windowWith({ log: plain(), answer: { ok: false, supported: false, error: "x" } });
  await w.regenerateReply("q1", false);
  assert.deepEqual(w.calls.resend, ["q1"]);
  assert.equal(w.ROLLBACK.supported, false);
  await w.regenerateReply("q1", false);
  assert.equal(w.calls.rollback.length, 1, "not asked again");
});

test("a refusal under the reply changes nothing and says why", async () => {
  const log = plain();
  const w = windowWith({ log, answer: { ok: false, supported: true, code: "turn_steered", error: "steered" } });
  await w.regenerateReply("q1", false);
  assert.equal(log.length, 4);
  assert.deepEqual(w.calls.submit, []);
  assert.deepEqual(w.calls.resend, []);
  assert.equal(w.calls.toasts.length, 1);
  assert.match(w.calls.toasts[0][1], /added to this answer/);
});

test("Try again falls back to the resend on a refusal, except while a turn runs", async () => {
  const tools = windowWith({ log: plain(), answer: { ok: false, supported: true, code: "turn_has_tools" } });
  await tools.regenerateReply("q1", true);
  assert.deepEqual(tools.calls.resend, ["q1"]);
  const running = windowWith({ log: plain(), answer: { ok: false, supported: true, code: "turn_in_progress" } });
  await running.regenerateReply("q1", true);
  assert.deepEqual(running.calls.resend, []);
  assert.match(running.calls.toasts[0][1], /still answering/);
});

test("the composer gates are checked before the agent is asked", async () => {
  const mic = windowWith({ log: plain(), voice: "recording", answer: { ok: true, supported: true, text: "Tell me a joke" } });
  await mic.regenerateReply("q1", false);
  const draft = windowWith({ log: plain(), draft: "half a thought", answer: { ok: true, supported: true, text: "Tell me a joke" } });
  await draft.regenerateReply("q1", false);
  for (const w of [mic, draft]) {
    assert.deepEqual(w.calls.rollback, []);
    assert.equal(w.S.log.length, 4);
    assert.equal(w.calls.toasts.length, 1);
  }
});

test("a running turn, an unsaved chat or an older question go the old way", async () => {
  const busy = windowWith({ log: plain(), busy: true, answer: { ok: true, supported: true, text: "x" } });
  await busy.regenerateReply("q1", true);
  const unsaved = windowWith({ log: plain(), sid: null, answer: { ok: true, supported: true, text: "x" } });
  await unsaved.regenerateReply("q1", false);
  const older = windowWith({ log: plain(), answer: { ok: true, supported: true, text: "x" } });
  await older.regenerateReply("q0", true);
  for (const w of [busy, unsaved, older]) {
    assert.deepEqual(w.calls.rollback, []);
    assert.equal(w.calls.resend.length, 1);
  }
});

test("when the agent took back a different question, the chat is redrawn and nothing is sent", async () => {
  const w = windowWith({ log: plain(), answer: { ok: true, supported: true, text: "Hi" } });
  await w.regenerateReply("q1", true);
  assert.deepEqual(w.calls.opened, ["ses-1"]);
  assert.deepEqual(w.calls.submit, []);
  assert.equal(w.S.draft, "Hi");
});

test("a question the agent never stored falls back to the old resend", async () => {
  const log = plain();
  const w = windowWith({ log, answer: { ok: false, supported: true, code: "turn_mismatch", error: "x" } });
  await w.regenerateReply("q1", true);
  assert.deepEqual(w.calls.resend, ["q1"]);
  assert.equal(log.length, 4, "nothing removed on screen");
  assert.deepEqual(w.calls.submit, []);
});

test("a stopped turn falls back to the old resend", async () => {
  const log = plain();
  const w = windowWith({ log, answer: { ok: false, supported: true, code: "turn_stopped", error: "x" } });
  await w.regenerateReply("q1", false);
  assert.deepEqual(w.calls.resend, ["q1"]);
  assert.equal(log.length, 4);
});

test("a question taken back while another chat was opened waits for its own chat", async () => {
  const log = plain();
  const w = windowWith({ log, answer: { ok: true, supported: true, text: "Tell me a joke" } });
  // The person opens another chat while the agent answers.
  w.BR.rollbackLastTurn = async () => { w.S.log = []; w.S.agentSession = "ses-2"; return { ok: true, supported: true, text: "Tell me a joke" }; };
  await w.regenerateReply("q1", false);
  assert.deepEqual(w.calls.submit, []);
  assert.equal(w.ROLLBACK.stash.get("ses-1"), "Tell me a joke");
  w.S.agentSession = "ses-1";
  w.rollbackStashBack("ses-1");
  assert.equal(w.entry.value, "Tell me a joke");
  assert.equal(w.ROLLBACK.stash.has("ses-1"), false);
});


/* ATO-1420: the agent's own check, as planLastTurnRollback makes it, on a
   chat whose window was cleared: "Hi" answered before Clear Transcript, then
   "continue" answered for real, then a second "continue" that failed and
   never reached the agent's store. */
function agentChat() {
  const turns = [
    { kind: "user", text: "Hi" }, { kind: "assistant_reply", text: "Hello" },
    { kind: "user", text: "continue" }, { kind: "assistant_reply", text: "real answer" },
  ];
  const answer = (expectText, prior, unanswered) => {
    let start = -1;
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i].kind === "user") { start = i; break; }
    const q = turns[start];
    const before = turns.slice(0, start).filter((t) => t.kind === "user").length;
    const replied = turns.slice(start + 1).some((t) => t.kind === "assistant_reply");
    if (q.text !== expectText || before !== prior || (unanswered === true && replied)) {
      return { ok: false, supported: true, code: "turn_mismatch", error: "not that one" };
    }
    turns.splice(start);
    return { ok: true, supported: true, text: q.text };
  };
  return { turns, answer };
}

test("after Clear Transcript, a failed repeat never takes back the earlier real answer (ATO-1420)", async () => {
  const agent = agentChat();
  const w = windowWith({ log: [{ id: "q0", k: "user", text: "Hi" }, { id: "a0", k: "assistant", text: "Hello" }], answer: agent.answer });
  // Clear Transcript, as the 'clear' action runs it.
  const before = w.S.log;
  w.S.log = [];
  w.rollbackNoteCleared(before, w.S.log, w.S.agentSession);
  w.S.log.push(
    { id: "q1", k: "user", text: "continue" }, { id: "a1", k: "assistant", text: "real answer" },
    { id: "q2", k: "user", text: "continue" }, { id: "f2", k: "system", text: "turn failed" },
  );
  await w.regenerateReply("q2", true);
  assert.equal(w.calls.prior, 2, "the cleared question counts");
  assert.equal(w.calls.unanswered, true, "the window shows no answer to it");
  assert.deepEqual(agent.turns.map((t) => t.text), ["Hi", "Hello", "continue", "real answer"], "the real answer stays");
  assert.deepEqual(w.calls.resend, ["q2"], "the question is sent again as a new turn");
  assert.equal(w.S.log.length, 4, "nothing removed on screen");
});

test("a failed repeat with a wrong count is still refused for its missing answer (ATO-1420)", async () => {
  const agent = agentChat();
  // The cleared question is not known to the window (say, cleared before the chat was saved).
  const w = windowWith({
    log: [
      { id: "q1", k: "user", text: "continue" }, { id: "a1", k: "assistant", text: "real answer" },
      { id: "q2", k: "user", text: "continue" }, { id: "f2", k: "system", text: "turn failed" },
    ],
    answer: agent.answer,
  });
  // Off by one the way the bug was: position 1 is the stored "continue".
  await w.regenerateReply("q2", true);
  assert.equal(w.calls.prior, 1);
  assert.equal(w.calls.unanswered, true);
  assert.equal(agent.turns.length, 4, "the real answer stays");
  assert.deepEqual(w.calls.resend, ["q2"]);
});

test("after Clear Transcript, Regenerate on the last answered question takes it back (ATO-1420)", async () => {
  const agent = agentChat();
  const w = windowWith({ log: [{ id: "q0", k: "user", text: "Hi" }, { id: "a0", k: "assistant", text: "Hello" }], answer: agent.answer });
  const before = w.S.log;
  w.S.log = [];
  w.rollbackNoteCleared(before, w.S.log, w.S.agentSession);
  w.S.log.push({ id: "q1", k: "user", text: "continue" }, { id: "a1", k: "assistant", text: "real answer" });
  await w.regenerateReply("q1", false);
  assert.equal(w.calls.prior, 1);
  assert.equal(w.calls.unanswered, false);
  assert.deepEqual(agent.turns.map((t) => t.text), ["Hi", "Hello"]);
  assert.deepEqual(w.calls.submit, ["continue"]);
});

test("the cleared count belongs to its chat", () => {
  const w = windowWith({ log: [], answer: { ok: false, supported: true } });
  w.rollbackNoteCleared([{ k: "user", text: "a" }, { k: "user", text: "b", steered: true }], [], "ses-1");
  w.rollbackNoteCleared([{ k: "user", text: "c" }], [], "ses-1");
  assert.deepEqual({ ...w.ROLLBACK.cleared }, { sid: "ses-1", n: 2 });
  w.rollbackNoteCleared([{ k: "user", text: "d" }], [], "ses-2");
  assert.deepEqual({ ...w.ROLLBACK.cleared }, { sid: "ses-2", n: 1 });
});
