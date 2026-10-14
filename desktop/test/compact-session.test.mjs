// Unit tests for AgentClient.compactSession (ATO-259), against the built output.
// Run: npm run build && npm run test:unit
// `/compact` and the context popover's "Compact now" call the agent's
// POST /api/sessions/{id}/compact. The window words each answer, so the
// client has to tell a result, a busy agent, an unknown chat and an agent
// without the route apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AgentClient, requestErrorText } = require("../out/main/agent-client.js");

/** An agent stand-in answering one route; the client is pointed at it. */
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
  // Private in TypeScript; the built output is plain JS.
  client.port = server.address().port;
  client.token = "t0ken";
  return { client, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("a compaction reports its status and token estimates", async () => {
  const s = await standIn(() => [200, { status: "compacted", reason: "manual", tokensBefore: 30000, tokensAfter: 9000 }]);
  try {
    const r = await s.client.compactSession("ses/1");
    assert.deepEqual(r, { ok: true, supported: true, status: "compacted", tokensBefore: 30000, tokensAfter: 9000 });
    assert.equal(s.seen[0].method, "POST");
    assert.equal(s.seen[0].url, "/api/sessions/ses%2F1/compact");
    assert.equal(s.seen[0].auth, "Bearer t0ken");
  } finally { await s.close(); }
});

test("a noop is fine and keeps the agent's reason", async () => {
  const s = await standIn(() => [200, { status: "noop", reason: "manual", message: "No safe, useful reduction is available." }]);
  try {
    const r = await s.client.compactSession("s1");
    assert.equal(r.ok, true);
    assert.equal(r.status, "noop");
    assert.equal(r.message, "No safe, useful reduction is available.");
  } finally { await s.close(); }
});

test("409 is the agent's busy, not an error", async () => {
  const s = await standIn(() => [409, { status: "busy", reason: "manual" }]);
  try {
    const r = await s.client.compactSession("s1");
    assert.deepEqual(r, { ok: false, supported: true, status: "busy" });
  } finally { await s.close(); }
});

test("a failure carries the agent's message", async () => {
  const s = await standIn(() => [200, { status: "failed", reason: "manual", message: "summary was empty" }]);
  try {
    const r = await s.client.compactSession("s1");
    assert.equal(r.ok, false);
    assert.equal(r.status, "failed");
    assert.equal(r.message, "summary was empty");
  } finally { await s.close(); }
});

test("the route's own 404 is an unknown chat; the server's is an agent without the route", async () => {
  const known = await standIn(() => [404, { error: { message: "session not found: s1" } }]);
  try {
    const r = await known.client.compactSession("s1");
    assert.equal(r.supported, true);
    assert.equal(r.ok, false);
  } finally { await known.close(); }
  const old = await standIn(() => [404, { error: { message: "No route for POST /api/sessions/s1/compact" } }]);
  try {
    const r = await old.client.compactSession("s1");
    assert.equal(r.supported, false);
    assert.equal(r.ok, false);
  } finally { await old.close(); }
});

// A compaction can take longer than five minutes. Node's fetch (undici) gives
// up on any answer whose headers take over 300 s and throws a bare
// "fetch failed", which also cancels the compaction on the agent's side. The
// call therefore must not go through fetch at all: with fetch broken, it
// still gets the agent's answer.
test("the compaction does not go through fetch and its five-minute deadline", async () => {
  const s = await standIn(() => [200, { status: "compacted", tokensBefore: 2000, tokensAfter: 500 }]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  try {
    const r = await s.client.compactSession("s1");
    assert.equal(r.status, "compacted");
    assert.equal(s.seen[0].body, "{}");
  } finally {
    globalThis.fetch = realFetch;
    await s.close();
  }
});

test("an answer that is not JSON is a failure with its HTTP status", async () => {
  const server = createServer((_req, res) => { res.writeHead(502); res.end("bad gateway"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new AgentClient(process.cwd());
  client.port = server.address().port;
  client.token = "t0ken";
  try {
    const r = await client.compactSession("s1");
    assert.deepEqual(r, { ok: false, supported: true, error: "HTTP 502" });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("an agent that is gone is named by its cause, not a bare failure", async () => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const client = new AgentClient(process.cwd());
  client.port = port;
  client.token = "t0ken";
  const r = await client.compactSession("s1");
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});

test("requestErrorText adds fetch's cause and keeps the message first", () => {
  const timedOut = new TypeError("fetch failed", { cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }) });
  assert.equal(requestErrorText(timedOut), "fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)");
  const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }) });
  assert.equal(requestErrorText(refused), "fetch failed (connect ECONNREFUSED 127.0.0.1:1)");
  assert.equal(requestErrorText(new Error("plain")), "plain");
  assert.equal(requestErrorText("text"), "text");
});
