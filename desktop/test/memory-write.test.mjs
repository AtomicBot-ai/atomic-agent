// ATO-582: the Memory tab's edits go through the agent's /api/memory routes
// (ATO-1124), never as SQL of the desktop's. Against the built output.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MEMORY_WRITE_PATHS, parseMemoryWriteOp, memoryWriteRequest, interpretMemoryWrite, runMemoryWrite } =
  require("../out/main/memory-write.js");

const target = () => ({ base: "http://127.0.0.1:4100", headers: { authorization: "Bearer t", "content-type": "application/json" } });

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  fn.calls = calls;
  return fn;
}

test("the paths are the agent's, a key is escaped", () => {
  assert.equal(MEMORY_WRITE_PATHS.note(7), "/api/memory/notes/7");
  assert.equal(MEMORY_WRITE_PATHS.profileFact("home city"), "/api/memory/profile/home%20city");
  assert.equal(MEMORY_WRITE_PATHS.profileFact("a/b"), "/api/memory/profile/a%2Fb");
});

test("only well-formed ops pass", () => {
  assert.deepEqual(parseMemoryWriteOp({ op: "note.delete", id: 3 }), { op: "note.delete", id: 3 });
  assert.deepEqual(parseMemoryWriteOp({ op: "note.edit", id: 3, text: "x" }), { op: "note.edit", id: 3, text: "x" });
  assert.deepEqual(parseMemoryWriteOp({ op: "profile.delete", key: "name" }), { op: "profile.delete", key: "name" });
  assert.deepEqual(parseMemoryWriteOp({ op: "profile.edit", key: "name", value: "Nadia" }), { op: "profile.edit", key: "name", value: "Nadia" });
  for (const bad of [null, [], "x", { op: "note.delete", id: 0 }, { op: "note.delete", id: 1.5 }, { op: "note.delete", id: "3" },
    { op: "note.edit", id: 3 }, { op: "note.edit", id: 3, text: "   " }, { op: "profile.delete", key: "" },
    { op: "profile.edit", key: "k" }, { op: "profile.edit", key: "k", value: " " }, { op: "sql", sql: "DELETE FROM memories" }]) {
    assert.equal(typeof parseMemoryWriteOp(bad), "string", JSON.stringify(bad));
  }
});

test("each op makes its request; PATCH sends {text} for a note and {value} for a fact", () => {
  assert.deepEqual(memoryWriteRequest({ op: "note.edit", id: 4, text: "new" }), { method: "PATCH", path: "/api/memory/notes/4", body: { text: "new" } });
  assert.deepEqual(memoryWriteRequest({ op: "note.delete", id: 4 }), { method: "DELETE", path: "/api/memory/notes/4" });
  assert.deepEqual(memoryWriteRequest({ op: "profile.edit", key: "k", value: "v" }), { method: "PATCH", path: "/api/memory/profile/k", body: { value: "v" } });
  assert.deepEqual(memoryWriteRequest({ op: "profile.delete", key: "k" }), { method: "DELETE", path: "/api/memory/profile/k" });
});

test("a delete reaches the agent with its token and reports ok", async () => {
  const f = fakeFetch(200, { removed: true, id: 9 });
  const res = await runMemoryWrite({ op: "note.delete", id: 9 }, target, f);
  assert.equal(res.ok, true);
  assert.deepEqual(res.body, { removed: true, id: 9 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "http://127.0.0.1:4100/api/memory/notes/9");
  assert.equal(f.calls[0].init.method, "DELETE");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer t");
  assert.equal(f.calls[0].init.body, undefined);
});

test("an edit sends the text as JSON", async () => {
  const f = fakeFetch(200, { note: { id: 2, content: "fixed" } });
  const res = await runMemoryWrite({ op: "note.edit", id: 2, text: "fixed" }, target, f);
  assert.equal(res.ok, true);
  assert.equal(f.calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { text: "fixed" });
});

test("an agent without the routes is unsupported: update the agent", async () => {
  const f = fakeFetch(404, { error: { message: "No route for DELETE /api/memory/notes/9", type: "invalid_request_error", param: null, code: null } });
  const res = await runMemoryWrite({ op: "note.delete", id: 9 }, target, f);
  assert.deepEqual(res, { ok: false, reason: "unsupported", error: "Update the agent to edit memory here", status: 404 });
});

test("a 404 of the route's own means it was already removed", () => {
  const res = interpretMemoryWrite({ op: "profile.delete", key: "k" }, 404, JSON.stringify({ error: { message: "profile fact not found: k" } }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "gone");
});

test("a 400 carries the agent's own sentence", () => {
  const res = interpretMemoryWrite({ op: "note.edit", id: 1, text: "x" }, 400, JSON.stringify({ error: { message: "content: too long" } }));
  assert.deepEqual(res, { ok: false, reason: "error", error: "content: too long", status: 400 });
});

test("a bad op never reaches fetch; a stopped agent or a network error is a result, not a throw", async () => {
  const f = fakeFetch(200, {});
  assert.equal((await runMemoryWrite({ op: "note.delete", id: -1 }, target, f)).reason, "invalid");
  assert.equal(f.calls.length, 0);
  const stopped = await runMemoryWrite({ op: "note.delete", id: 1 }, () => { throw new Error("agent is not running"); }, f);
  assert.deepEqual(stopped, { ok: false, reason: "error", error: "agent is not running" });
  const down = await runMemoryWrite({ op: "note.delete", id: 1 }, target, async () => { throw new Error("fetch failed"); });
  assert.equal(down.reason, "error");
  assert.equal(down.error, "fetch failed");
});
