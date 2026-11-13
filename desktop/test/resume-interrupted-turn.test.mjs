// ATO-448: "Continue" on a chat a restart cut off. Only the click asks the
// agent (POST /api/sessions/{id}/resume) for the continuing message, which the
// window then sends as a normal turn; nothing continues by itself.
//
// The client half runs against the built output (npm run build first); the
// window half reads renderer.js as text and runs its functions in a vm
// context with their neighbours stubbed, as rollback-last-turn.test.mjs does.
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

test("a resume hands back the continuing message", async () => {
  const s = await standIn(() => [200, { id: "ses/1", text: "[Resumed] note\n\nThe interrupted request:\npush" }]);
  try {
    const r = await s.client.resumeInterruptedTurn("ses/1");
    assert.deepEqual(r, { ok: true, supported: true, text: "[Resumed] note\n\nThe interrupted request:\npush" });
    assert.equal(s.seen[0].method, "POST");
    assert.equal(s.seen[0].url, "/api/sessions/ses%2F1/resume");
    assert.equal(s.seen[0].auth, "Bearer t0ken");
    assert.equal(s.seen[0].body, "{}");
  } finally { await s.close(); }
});

test("release goes along as { release: true }", async () => {
  const s = await standIn(() => [200, { id: "s1", released: true }]);
  try {
    assert.deepEqual(await s.client.resumeInterruptedTurn("s1", true), { ok: true, supported: true });
    assert.equal(s.seen[0].body, JSON.stringify({ release: true }));
  } finally { await s.close(); }
});

test("a 409 carries the agent's code; an agent without the route is unsupported", async () => {
  const none = await standIn(() => [409, { error: { message: "nothing to resume", code: "nothing_to_resume" } }]);
  try {
    assert.deepEqual(await none.client.resumeInterruptedTurn("s1"),
      { ok: false, supported: true, code: "nothing_to_resume", error: "nothing to resume" });
  } finally { await none.close(); }
  const old = await standIn(() => [404, { error: { message: "No route for POST /api/sessions/s1/resume", code: null } }]);
  try {
    const r = await old.client.resumeInterruptedTurn("s1");
    assert.equal(r.ok, false);
    assert.equal(r.supported, false);
  } finally { await old.close(); }
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

const CUT_OFF = { status: "cancelled", lastError: "turn interrupted: the agent stopped before it finished" };

function windowWith({ answer, busy = false, draft = "", sid = "ses-1", log = [] } = {}) {
  const calls = { resume: [], submit: [], toasts: [], renders: 0 };
  const entry = { value: draft, focus() {} };
  let n = 0;
  const c = vm.createContext({
    S: { log, busy, pending: null, draft, agentSession: sid },
    VOICE: { state: "idle" },
    ANX: { messageAction() {} },
    BR: { resumeInterruptedTurn: async (id, release) => {
      calls.resume.push([id, release === true]);
      return typeof answer === "function" ? answer(id, release) : answer;
    } },
    $: () => entry,
    nid: () => "row-" + ++n,
    toast: (t, s) => calls.toasts.push([t, s]),
    autosize() {},
    render: () => { calls.renders++; },
    calls,
    entry,
  });
  vm.runInContext(
    constLine("INTERRUPTED_TURN_ERROR") + constLine("RESUME")
      + block("function interruptedTurnOffer(") + block("function dropInterruptedTurnOffer(") + block("async function continueInterruptedTurn(")
      + "globalThis.interruptedTurnOffer = interruptedTurnOffer; globalThis.continueInterruptedTurn = continueInterruptedTurn;"
      + "globalThis.submit = (t, opts) => calls.submit.push([S.draft, opts && opts.plain === true]);",
    c,
  );
  return c;
}

test("the offer appears only on a chat a restart cut off, never while its turn runs", () => {
  const w = windowWith();
  assert.equal(w.interruptedTurnOffer(CUT_OFF, false).act, "resume-turn");
  assert.equal(w.interruptedTurnOffer(CUT_OFF, true), null, "a turn is running there");
  assert.equal(w.interruptedTurnOffer({ status: "cancelled", lastError: null }, false), null, "the person stopped it");
  assert.equal(w.interruptedTurnOffer({ status: "completed", lastError: null }, false), null);
  assert.equal(w.interruptedTurnOffer(null, false), null);
});

test("an agent without the bridge call gets no offer", () => {
  const w = windowWith();
  w.BR = {};
  assert.equal(w.interruptedTurnOffer(CUT_OFF, false), null);
});

test("Continue asks the agent once and sends its message as a normal turn", async () => {
  const log = [{ id: "q", k: "user", text: "push" }, { id: "o", k: "system", act: "resume-turn", text: "x" }];
  const w = windowWith({ log, answer: { ok: true, supported: true, text: "[Resumed] go on" } });
  await w.continueInterruptedTurn();
  assert.deepEqual(w.calls.resume, [["ses-1", false]]);
  assert.deepEqual(w.calls.submit, [["[Resumed] go on", true]]);
  assert.deepEqual(log.map((x) => x.id), ["q"], "the offer row goes");
});

test("nothing to resume drops the offer and says so, sending nothing", async () => {
  const log = [{ id: "o", k: "system", act: "resume-turn", text: "x" }];
  const w = windowWith({ log, answer: { ok: false, supported: true, code: "nothing_to_resume" } });
  await w.continueInterruptedTurn();
  assert.deepEqual(w.calls.submit, []);
  assert.equal(log.length, 0);
  assert.match(w.calls.toasts[0][1], /nothing left to continue/);
});

test("a busy chat or a draft in the box asks nothing", async () => {
  const busy = windowWith({ busy: true, answer: { ok: true, supported: true, text: "x" } });
  await busy.continueInterruptedTurn();
  assert.deepEqual(busy.calls.resume, []);
  const drafted = windowWith({ draft: "my own words", answer: { ok: true, supported: true, text: "x" } });
  await drafted.continueInterruptedTurn();
  assert.deepEqual(drafted.calls.resume, []);
  assert.deepEqual(drafted.calls.submit, []);
});

test("a message the window cannot send any more is given back to the agent", async () => {
  const w = windowWith({ answer: (_id, release) => (release ? { ok: true, supported: true } : { ok: true, supported: true, text: "[Resumed] go on" }) });
  // The person typed while the agent answered.
  w.BR.resumeInterruptedTurn = async (id, release) => {
    w.calls.resume.push([id, release === true]);
    if (!release) w.entry.value = "typed meanwhile";
    return release ? { ok: true, supported: true } : { ok: true, supported: true, text: "[Resumed] go on" };
  };
  await w.continueInterruptedTurn();
  assert.deepEqual(w.calls.resume, [["ses-1", false], ["ses-1", true]]);
  assert.deepEqual(w.calls.submit, []);
});
