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
const { AgentClient } = require("../out/main/agent-client.js");

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
