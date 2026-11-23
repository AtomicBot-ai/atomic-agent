// Unit tests for ATO-1152 (/btw, a side question that is not saved to the
// chat): the pure half of renderer/side-question.js, main/side-question.ts
// and AgentClient.askSideQuestion (against the built output), and the wiring
// read from the sources.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const B = require("../renderer/side-question.js");
const M = require("../out/main/side-question.js");
const { AgentClient } = require("../out/main/agent-client.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const h = { esc: (s) => String(s).replace(/</g, "&lt;"), ic: (n) => "<svg data-ic=\"" + n + "\"></svg>" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the words after /btw are the question; none prints the usage", () => {
  assert.deepEqual(B.btwQuestionFrom(["which", "port?"]), { ok: true, text: "which port?" });
  assert.deepEqual(B.btwQuestionFrom([]), { ok: false, error: B.BTW_USAGE });
  assert.equal(B.btwQuestionFrom(["x".repeat(B.BTW_MAX_CHARS + 1)]).ok, false);
  assert.ok(!B.BTW_USAGE.includes("—"));
});

test("a chat the agent has not saved yet is asked without context", () => {
  assert.equal(B.btwSessionOf("s1"), "s1");
  assert.equal(B.btwSessionOf("waiting-12"), undefined);
  assert.equal(B.btwSessionOf(null), undefined);
});

test("asking shows the card, the answer fills it, and nothing goes to the chat", async () => {
  const asked = [];
  let paints = 0;
  const bridge = { askSideQuestion: async (q, sid) => { asked.push([q, sid]); return { ok: true, supported: true, text: " Port **8080**. " }; } };
  assert.equal(B.btwAsk(["which", "port?"], { bridge, sessionId: "s1", paint: () => { paints += 1; } }), "");
  assert.equal(B.BTW.card.status, "asking");
  assert.match(B.btwCardHTML(h), /Thinking/);
  await tick(); await tick();
  assert.deepEqual(asked, [["which port?", "s1"]]);
  assert.equal(B.BTW.card.status, "done");
  assert.equal(B.BTW.card.text, "Port **8080**.");
  assert.equal(paints, 2);
  const html = B.btwCardHTML({ ...h, md: (t) => "<p>" + t + "</p>" });
  assert.match(html, /not saved to the chat/);
  assert.match(html, /<p>Port \*\*8080\*\*\.<\/p>/);
  assert.match(html, /data-btw-close/);
  B.btwClose();
  assert.equal(B.btwCardHTML(h), "");
});

test("an answer that lands after the card was closed or replaced is dropped", async () => {
  let release;
  const slow = { askSideQuestion: () => new Promise((resolve) => { release = resolve; }) };
  B.btwAsk(["first"], { bridge: slow, sessionId: "s1" });
  await tick();
  B.btwClose();
  release({ ok: true, supported: true, text: "late" });
  await tick(); await tick();
  assert.equal(B.BTW.card, null);
  B.btwAsk(["one"], { bridge: slow, sessionId: "s1" });
  await tick();
  const firstRelease = release;
  B.btwAsk(["two"], { bridge: { askSideQuestion: async () => ({ ok: true, supported: true, text: "answer two" }) }, sessionId: "s1" });
  await tick(); await tick();
  firstRelease({ ok: true, supported: true, text: "answer one" });
  await tick(); await tick();
  assert.equal(B.BTW.card.question, "two");
  assert.equal(B.BTW.card.text, "answer two");
  B.btwClose();
});

test("failures are worded; an old agent says to update; the question is escaped", async () => {
  assert.match(B.btwOutcome({ ok: false, supported: false }).text, /cannot answer side questions/);
  assert.equal(B.btwOutcome({ ok: false, supported: true, error: "timed out" }).text, "Couldn't answer the side question: timed out.");
  assert.equal(B.btwOutcome({ ok: true, text: "  " }).status, "failed");
  B.btwAsk(["<b>hi</b>"], { bridge: { askSideQuestion: async () => { throw new Error("gone"); } } });
  await tick(); await tick();
  assert.equal(B.BTW.card.status, "failed");
  assert.match(B.btwCardHTML(h), /gone/);
  assert.doesNotMatch(B.btwCardHTML(h), /<b>/);
  B.btwClose();
});

test("main checks the request before it goes to the agent", () => {
  assert.deepEqual(M.sideQuestionRequest({ question: " hi ", sessionId: "s1" }), { ok: true, question: "hi", sessionId: "s1" });
  assert.deepEqual(M.sideQuestionRequest({ question: "hi", sessionId: "waiting-1" }), { ok: true, question: "hi" });
  assert.equal(M.sideQuestionRequest({ question: "  " }).ok, false);
  assert.equal(M.sideQuestionRequest(null).ok, false);
  assert.equal(M.sideQuestionRequest({ question: "x".repeat(M.SIDE_QUESTION_MAX_CHARS + 1) }).ok, false);
});

async function standIn(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      const [status, payload] = answer(req);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new AgentClient(process.cwd());
  client.port = server.address().port;
  client.token = "t0ken";
  return { client, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("the client posts to /api/btw and reads the answer", async () => {
  const s = await standIn(() => [200, { text: "8080" }]);
  try {
    assert.deepEqual(await s.client.askSideQuestion("which port?", "s1"), { ok: true, supported: true, text: "8080" });
    assert.equal(s.seen[0].method, "POST");
    assert.equal(s.seen[0].url, "/api/btw");
    assert.deepEqual(JSON.parse(s.seen[0].body), { question: "which port?", session_id: "s1" });
    await s.client.askSideQuestion("hi");
    assert.deepEqual(JSON.parse(s.seen[1].body), { question: "hi" });
  } finally { await s.close(); }
});

test("an agent without the route is unsupported; a model failure keeps its reason", async () => {
  const old = await standIn(() => [404, "No route for POST /api/btw"]);
  try {
    const r = await old.client.askSideQuestion("hi");
    assert.equal(r.ok, false);
    assert.equal(r.supported, false);
  } finally { await old.close(); }
  const bad = await standIn(() => [502, { error: { message: "the model returned no answer" } }]);
  try {
    assert.deepEqual(await bad.client.askSideQuestion("hi"), { ok: false, supported: true, error: "the model returned no answer" });
  } finally { await bad.close(); }
});

test("renderer, preload, main and the client use the same names", () => {
  const r = src("../renderer/renderer.js");
  assert.match(r, /\['btw','ask a quick side question; the answer is not saved to the chat','<question>'\]/);
  assert.match(r, /btwAsk\(rest, \{bridge: BR, sessionId: S\.agentSession, paint: render\}\)/);
  assert.match(r, /btwCardHTML\(\{esc, ic, md: renderMarkdown\}\)/);
  const html = src("../renderer/index.html");
  assert.ok(html.indexOf('src="side-question.js"') > 0 && html.indexOf('src="side-question.js"') < html.indexOf('src="renderer.js"'));
  assert.match(html, /href="css\/side-question\.css"/);
  assert.match(src("../preload/preload.ts"), /askSideQuestion: \(question: string, sessionId\?: string\) =>\s+ipcRenderer\.invoke\("agent:btw"/);
  assert.match(src("../main/side-question-ipc.ts"), /ipcMain\.handle\("agent:btw"/);
  assert.match(src("../main/main.ts"), /wireSideQuestionIpc\(client\)/);
  assert.match(src("../main/analytics/catalog-values.ts"), /"btw"/);
});
