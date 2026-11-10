// Issue #996: Settings › Performance asks the agent for the local model's
// numbers. Main answers the window with exactly one of ok / unsupported (an
// agent from before the route: 404) / unreachable, never a throw, so the pane
// can tell "update the agent" from "the agent is not answering".
// Run: npm run build && npm run test:unit (against the built output).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AgentClient } = require("../out/main/agent-client.js");
const { localPerformanceResult } = require("../out/main/local-performance.js");

const BODY = {
  local: true, url: "http://127.0.0.1:9931", capacity: 300,
  samples: [{ at: 1794329429000, modelId: "Qwen3.6-35B-A3B-MXFP4_MOE.gguf", streamed: true, promptTokens: 2, cacheTokens: 0,
    promptMs: 32.969, promptPerSecond: 60.663047104856076, predictedTokens: 40, predictedMs: 1158.29,
    generationPerSecond: 33.67032435745798, ttftMs: 412.0, contextTokens: 42, concurrent: 1 }],
  slots: { total: 1, busy: 0, contextPerSlot: 262144 },
};

/** An agent stand-in answering one route; the client is pointed at it. */
async function standIn(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const [status, raw] = answer(req);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(raw);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new AgentClient(process.cwd());
  // Private in TypeScript; the built output is plain JS.
  client.port = server.address().port;
  client.token = "t0ken";
  return { client, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

const ask = (client) => localPerformanceResult(() => client.localPerformance());

test("200: the agent's body, from GET /api/local-model/performance with the key", async () => {
  const s = await standIn(() => [200, JSON.stringify(BODY)]);
  try {
    assert.deepEqual(await ask(s.client), { ok: true, data: BODY });
    assert.equal(s.seen[0].method, "GET");
    assert.equal(s.seen[0].url, "/api/local-model/performance");
    assert.equal(s.seen[0].auth, "Bearer t0ken");
  } finally { await s.close(); }
});

test("404: an agent from before the route is unsupported, not an error", async () => {
  const s = await standIn(() => [404, JSON.stringify({ error: { message: "No route for GET /api/local-model/performance" } })]);
  try {
    assert.deepEqual(await ask(s.client), { ok: false, kind: "unsupported" });
  } finally { await s.close(); }
});

test("another status, or a body that is not JSON, is unreachable", async () => {
  const s = await standIn((req) => (s.seen.length === 1 ? [500, "{}"] : [200, "not json"]));
  try {
    assert.deepEqual(await ask(s.client), { ok: false, kind: "unreachable", error: "HTTP 500" });
    const bad = await ask(s.client);
    assert.equal(bad.ok, false);
    assert.equal(bad.kind, "unreachable");
    assert.ok(bad.error.length > 0);
  } finally { await s.close(); }
});

test("a 200 that is not an object is unreachable", async () => {
  for (const raw of ["null", "[]", "7"]) {
    const s = await standIn(() => [200, raw]);
    try {
      const r = await ask(s.client);
      assert.equal(r.ok, false, raw);
      assert.equal(r.kind, "unreachable", raw);
    } finally { await s.close(); }
  }
});

test("an agent that is not started, or a closed port, is unreachable", async () => {
  const idle = new AgentClient(process.cwd());
  assert.deepEqual(await ask(idle), { ok: false, kind: "unreachable", error: "agent is not running" });
  const s = await standIn(() => [200, "{}"]);
  const port = s.client.port;
  await s.close();
  const gone = new AgentClient(process.cwd());
  gone.port = port;
  gone.token = "t0ken";
  const r = await ask(gone);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "unreachable");
});

test("a throw from the fetch never reaches the window", async () => {
  assert.deepEqual(await localPerformanceResult(async () => { throw new Error("The operation was aborted due to timeout"); }),
    { ok: false, kind: "unreachable", error: "The operation was aborted due to timeout" });
  assert.deepEqual(await localPerformanceResult(async () => { throw "odd"; }), { ok: false, kind: "unreachable", error: "odd" });
});
