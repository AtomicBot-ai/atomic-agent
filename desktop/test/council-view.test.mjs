// Unit tests for ATO-2432 (/council, the model council beside the chat):
// the pure half of renderer/council-view.js, main/council-client.ts
// (against the built output, with a local fake agent), and the wiring read
// from the sources.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const V = require("../renderer/council-view.js");
const C = require("../out/main/council-client.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const h = { esc: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"), ic: (n) => "<svg data-ic=\"" + n + "\"></svg>" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const REPORT = {
  question: "Which db?",
  answers: [
    { model: "or:a", text: "Postgres", ms: 1 },
    { model: "or:b", text: "SQLite", ms: 1 },
    { model: "or:c", error: "401", ms: 1 },
  ],
  judge: "or:a",
  summary: { agree: ["SQL works"], disagree: ["A says Postgres, B says SQLite"], unique: { "or:a": ["replication"], "or:b": [] }, parsed: true, raw: "" },
  standings: [{ model: "or:b", averageRank: 1, votes: 1 }, { model: "or:a", averageRank: 2, votes: 1 }],
  chairman: { model: "or:a", text: "Use **SQLite**." },
  notes: [],
};

test("the words after /council: flags anywhere, the rest is the question", () => {
  assert.deepEqual(V.councilParse(["--models", "a,b*2", "which", "--no-rank", "db?", "--max-usd", "$0.5"]), {
    ok: true,
    request: { models: "a,b*2", rank: false, maxUsd: 0.5, question: "which db?" },
  });
  assert.deepEqual(V.councilParse(["stop"]), { ok: true, stop: true });
  assert.deepEqual(V.councilParse([]), { ok: false, error: V.COUNCIL_USAGE });
  assert.equal(V.councilParse(["q", "--judge"]).ok, false);
  assert.equal(V.councilParse(["x".repeat(V.COUNCIL_MAX_CHARS + 1)]).ok, false);
  assert.ok(!V.COUNCIL_USAGE.includes("—"));
});

test("a council runs in a card: forecast and stage while asking, the verdict when done", async () => {
  V.COUNCIL.card = null;
  V.COUNCIL.listening = false;
  let onFrame = null;
  let release;
  const asked = [];
  const bridge = {
    council: (req) => { asked.push(req); return new Promise((resolve) => { release = resolve; }); },
    councilStop: async () => true,
    onCouncilFrame: (cb) => { onFrame = cb; return () => {}; },
  };
  let paints = 0;
  assert.equal(V.councilAsk(["which", "db?"], { bridge, paint: () => { paints += 1; } }), "");
  await tick();
  const id = V.COUNCIL.card.id;
  assert.deepEqual(asked, [{ id, question: "which db?" }]);
  assert.match(V.councilCardHTML(h), /aria-busy="true"/);
  assert.match(V.councilCardHTML(h), /data-council-stop/);
  onFrame({ id, event: "forecast", data: { cost_line: "Up to 8 requests, at most $0.00 (free: local)" } });
  onFrame({ id, event: "progress", data: { stage: "answered", done: 2, total: 3 } });
  onFrame({ id: "other", event: "progress", data: { stage: "chairman" } });
  const asking = V.councilCardHTML(h);
  assert.match(asking, /Up to 8 requests/);
  assert.match(asking, /2 of 3 answered/);
  assert.equal(V.councilAsk(["again"], { bridge }), "A council is already running; wait for it or type /council stop.");
  release({ ok: true, supported: true, report: REPORT, costLine: "Up to 8 requests" });
  await tick();
  const html = V.councilCardHTML(h);
  // Final answer first, then agree / disagree, ranking, answers.
  const at = ["cou-final", "cou-sum", "cou-rank", "cou-answers"].map((c) => html.indexOf(c));
  assert.ok(at.every((i) => i > 0));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.match(html, /<span class="cou-place">#1<\/span><span class="cou-m">or:b<\/span>/);
  assert.match(html, /No answer\.<\/div><details class="cou-det"><summary>Details<\/summary>401/);
  assert.match(html, /Only this one/);
  assert.ok(!html.includes("data-council-stop"));
  assert.ok(paints >= 2);
});

test("stop closes the card and aborts the request; a late outcome is dropped", async () => {
  V.COUNCIL.card = null;
  const stopped = [];
  let release;
  const bridge = {
    council: () => new Promise((resolve) => { release = resolve; }),
    councilStop: async (id) => { stopped.push(id); return true; },
    onCouncilFrame: () => () => {},
  };
  V.councilAsk(["q"], { bridge });
  await tick();
  const id = V.COUNCIL.card.id;
  assert.equal(V.councilAsk(["stop"], { bridge }), "");
  await tick();
  assert.deepEqual(stopped, [id]);
  assert.equal(V.COUNCIL.card, null);
  release({ ok: true, supported: true, report: REPORT });
  await tick();
  assert.equal(V.COUNCIL.card, null);
  assert.equal(V.councilAsk(["stop"], { bridge }), "No council is running.");
});

test("failures read plainly with the reason behind Details; an old agent says to update", () => {
  assert.deepEqual(V.councilOutcome({ ok: false, supported: false, error: "x" }), {
    status: "failed", error: "This agent has no model council. Update Atomic Agent to use /council.", details: "",
  });
  assert.deepEqual(V.councilOutcome({ ok: false, supported: true, error: "fetch failed" }), {
    status: "failed", error: "Couldn't run the council.", details: "fetch failed",
  });
  const over = V.councilOutcome({ ok: false, supported: true, error: "this council could cost up to $1.00, over the $0.10 limit; nothing was sent" });
  assert.equal(over.error, "This council could cost up to $1.00, over the $0.10 limit; nothing was sent.");
  assert.equal(V.councilOutcome({ ok: true, supported: true, costLine: "Up to 4" }, true).report, null);
});

test("councilRequest checks the window's request and maps it to the route body", () => {
  assert.deepEqual(C.councilRequest({ question: " q ", models: "a,b", chairman: null, rank: false, maxUsd: 0.2, dryRun: true }), {
    ok: true,
    body: { question: "q", models: "a,b", chairman: null, rank: false, max_usd: 0.2, dry_run: true },
  });
  assert.equal(C.councilRequest({ question: "" }).ok, false);
  assert.equal(C.councilRequest({ question: "x".repeat(C.COUNCIL_MAX_CHARS + 1) }).ok, false);
});

test("splitSseFrames keeps an unfinished frame for the next chunk and skips keepalives", () => {
  const a = C.splitSseFrames(": keepalive\n\nevent: progress\ndata: {\"stage\":\"answering\"}\n\nevent: res");
  assert.deepEqual(a.frames, [{ event: "progress", data: { stage: "answering" } }]);
  const b = C.splitSseFrames(a.rest + "ult\ndata: {\"report\":{}}\n\n");
  assert.deepEqual(b.frames, [{ event: "result", data: { report: {} } }]);
  assert.equal(b.rest, "");
});

async function fakeAgent(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { target: () => ({ base, headers: { "content-type": "application/json" } }), close: () => new Promise((r) => server.close(r)) };
}

test("runCouncilRequest streams frames and resolves with the result", async () => {
  const agent = await fakeAgent((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: forecast\ndata: {\"cost_line\":\"Up to 4 requests\"}\n\n");
    res.write("event: progress\ndata: {\"stage\":\"chairman\",\"chairman\":\"a\"}\n\n");
    res.end("event: result\ndata: {\"report\":{\"question\":\"q\"},\"cost_line\":\"Up to 4 requests\",\"skipped\":[]}\n\n");
  });
  try {
    const frames = [];
    const out = await C.runCouncilRequest(agent.target, { question: "q" }, { onFrame: (f) => frames.push(f.event) });
    assert.deepEqual(frames, ["forecast", "progress", "result"]);
    assert.deepEqual(out, { ok: true, supported: true, report: { question: "q" }, costLine: "Up to 4 requests", skipped: [] });
  } finally {
    await agent.close();
  }
});

test("an agent from before the route is unsupported; an error frame is a failure", async () => {
  const old = await fakeAgent((req, res) => { res.writeHead(404); res.end("No route for POST /api/council"); });
  try {
    assert.deepEqual(await C.runCouncilRequest(old.target, { question: "q" }), { ok: false, supported: false, error: "This agent has no model council" });
  } finally {
    await old.close();
  }
  const failing = await fakeAgent((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("event: error\ndata: {\"message\":\"no council seat could be used\"}\n\n");
  });
  try {
    assert.deepEqual(await C.runCouncilRequest(failing.target, { question: "q" }), { ok: false, supported: true, error: "no council seat could be used" });
  } finally {
    await failing.close();
  }
});

test("wiring: main, preload, index.html and renderer.js hooks", () => {
  assert.match(src("../main/main.ts"), /wireCouncilIpc\(client\);/);
  const ipc = src("../main/council-ipc.ts");
  assert.match(ipc, /"agent:council"/);
  assert.match(ipc, /"agent:council-stop"/);
  assert.match(ipc, /"agent:council-frame"/);
  const preload = src("../preload/preload.ts");
  assert.match(preload, /council: \(request: unknown\) => ipcRenderer\.invoke\("agent:council", request\)/);
  assert.match(preload, /councilStop: \(id: string\) => ipcRenderer\.invoke\("agent:council-stop", \{ id \}\)/);
  assert.match(preload, /onCouncilFrame: .*on\("agent:council-frame", cb\)/);
  const html = src("../renderer/index.html");
  assert.ok(html.indexOf('<script src="council-view.js"></script>') < html.indexOf('<script src="renderer.js"></script>'));
  assert.match(html, /css\/council-view\.css/);
  const r = src("../renderer/renderer.js");
  assert.match(r, /\['council',/);
  assert.match(r, /councilCardHTML\(\{esc, ic, md: renderMarkdown\}\)/);
  assert.match(r, /if \(name === 'council'\) \{ const said = councilAsk\(rest/);
});
