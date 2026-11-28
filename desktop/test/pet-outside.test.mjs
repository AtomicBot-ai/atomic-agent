// ATO-2513: turns the desktop did not start (cron, Telegram, the terminal),
// read from the session rows (main/pet-outside.ts), and the tracker's own
// sessions it skips (main/pet-events.ts ownSession).
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PetOutsideTurns, petSessionRows, petRowEnding, PET_OUTSIDE_STALE_MS } = require("../out/main/pet-outside.js");
const { PetTracker } = require("../out/main/pet-events.js");

const row = (id, status, turnCount, updatedAt = 1) => ({ id, status, turnCount, updatedAt });
const notOwn = () => false;

test("reads /api/sessions rows and drops malformed ones", () => {
  const rows = petSessionRows({ sessions: [{ id: "a", status: "running", turnCount: 2, updatedAt: 5 }, { id: 3 }, null, { id: "b" }] });
  assert.deepEqual(rows, [{ id: "a", status: "running", turnCount: 2, updatedAt: 5 }]);
  assert.deepEqual(petSessionRows(null), []);
});

test("a cron turn running shows as thinking, and its end flashes once", () => {
  const o = new PetOutsideTurns();
  assert.deepEqual(o.update([row("cron", "completed", 1)], notOwn, 0), [], "the first read is the baseline");
  assert.equal(o.activity(0), null);
  o.update([row("cron", "running", 1, 2)], notOwn, 5_000);
  assert.equal(o.activity(5_000), "thinking");
  const ends = o.update([row("cron", "completed", 2, 3)], notOwn, 10_000);
  assert.deepEqual(ends, [{ sessionId: "cron", ending: "done" }]);
  assert.equal(o.activity(10_000), null);
  assert.deepEqual(o.update([row("cron", "completed", 2, 3)], notOwn, 15_000), [], "not twice");
});

test("a turn that started and ended between two reads still counts", () => {
  const o = new PetOutsideTurns();
  o.update([row("tg", "completed", 3, 10)], notOwn, 0);
  assert.deepEqual(o.update([row("tg", "failed", 4, 20)], notOwn, 5_000), [{ sessionId: "tg", ending: "error" }]);
  // A new chat a Telegram message made between reads: newer than anything seen.
  assert.deepEqual(o.update([row("new", "completed", 1, 30), row("tg", "failed", 4, 20)], notOwn, 10_000), [{ sessionId: "new", ending: "done" }]);
});

test("nothing is flashed at the first read, and an old row coming back is not a turn", () => {
  const o = new PetOutsideTurns();
  assert.deepEqual(o.update([row("a", "failed", 5, 100)], notOwn, 0), []);
  assert.deepEqual(o.update([row("old", "completed", 9, 50)], notOwn, 5_000), [], "older than the newest row seen");
});

test("this window's own sessions are skipped: the chat stream already told the pet", () => {
  const o = new PetOutsideTurns();
  o.update([], notOwn, 0);
  o.update([row("mine", "running", 1, 5)], () => true, 5_000);
  assert.equal(o.activity(5_000), null);
  assert.deepEqual(o.update([row("mine", "completed", 2, 6)], () => true, 10_000), []);
});

test("endings in the pet's words; a row gone for long stops counting", () => {
  assert.equal(petRowEnding("completed"), "done");
  assert.equal(petRowEnding("failed"), "error");
  assert.equal(petRowEnding("stalled"), "error");
  assert.equal(petRowEnding("cancelled"), "stopped");
  const o = new PetOutsideTurns();
  o.update([], notOwn, 0);
  o.update([row("x", "running", 1, 5)], notOwn, 1_000);
  assert.equal(o.activity(1_000 + PET_OUTSIDE_STALE_MS + 1), null);
});

test("the tracker knows the sessions its own turns run in, and ended in since a time", () => {
  const t = new PetTracker();
  t.observeChat({ turnId: "t1", kind: "session_id", payload: { sessionId: "s1" } }, 0);
  assert.equal(t.ownSession("s1", 0), true, "running now");
  t.observeChat({ turnId: "t1", kind: "done", payload: {} }, 100);
  assert.equal(t.ownSession("s1", 50), true, "ended after the last read");
  assert.equal(t.ownSession("s1", 200), false, "ended before it");
  assert.equal(t.ownSession("other", 0), false);
});

test("an outside turn's end drops the requests of its session", () => {
  const t = new PetTracker();
  t.observeApproval({ approvalId: "ap-1", sessionId: "tg", tool: "shell.exec", preview: "ls", category: "shell" }, 0);
  assert.equal(t.pending().length, 1);
  assert.equal(t.sessionEnded("tg"), true);
  assert.equal(t.pending().length, 0);
});
