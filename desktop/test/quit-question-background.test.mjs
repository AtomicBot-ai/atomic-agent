// Unit tests for the ATO-1758 half of main/quit-question.ts, against the built output.
// Run: npm run build && npm run test:unit
// A quit used to ask only about this window's chats. A scheduled task running,
// or a reply the agent writes to Telegram or Discord, was stopped without a
// word. The question now counts them, by what the agent itself reports, and
// names what is running. Every test here fails on the ATO-1696 code alone:
// quitQuestion ignored `tasks` and `background`, and the helpers did not exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  quitQuestion, backgroundQuitWork, sampleAgentBusy, busyTurnsOf, QUIT_PROBE_MS,
} = require("../out/main/quit-question.js");

test("a scheduled task alone asks, and names the task", () => {
  assert.deepEqual(quitQuestion({ queued: 0, working: 0, tasks: 1 }), {
    message: "A scheduled task is still running",
    detail: "Quitting now stops it before it is done.",
  });
  const two = quitQuestion({ queued: 0, working: 0, tasks: 2 });
  assert.equal(two.message, "2 scheduled tasks are still running");
  assert.match(two.detail, /stops them before they are done\./);
});

test("a channel reply alone asks, and names Telegram", () => {
  const one = quitQuestion({ queued: 0, working: 0, background: 1 });
  assert.equal(one.message, "A reply in Telegram or another channel is still being written");
  assert.match(one.detail, /cuts it off before it is sent\./);
  const three = quitQuestion({ queued: 0, working: 0, background: 3 });
  assert.equal(three.message, "3 replies in Telegram or other channels are still being written");
  assert.match(three.detail, /cuts them off/);
});

test("several kinds at once: one question that lists each kind by name", () => {
  const q = quitQuestion({ queued: 0, working: 1, tasks: 2, background: 1 });
  assert.equal(q.message, "Atomic Agent is still working");
  assert.equal(q.detail, "Still running: a chat, 2 scheduled tasks and a reply in Telegram or another channel. Quitting now stops all of it before it is done.");
  // Two kinds join with "and" alone; queued messages are still named after the stop.
  const two = quitQuestion({ queued: 1, working: 0, tasks: 1, background: 2 });
  assert.equal(two.detail, "Still running: a scheduled task and 2 replies in Telegram or other channels. Quitting now stops all of it before it is done. A queued message is dropped too.");
});

test("the ATO-1696 words for chats alone are unchanged with the new fields at zero or absent", () => {
  assert.deepEqual(quitQuestion({ queued: 0, working: 1, tasks: 0, background: 0 }), {
    message: "A chat is still working",
    detail: "Quitting now stops its reply before it is done.",
  });
  assert.equal(quitQuestion({ queued: 0, working: 0, tasks: 0, background: 0 }), null);
  assert.equal(quitQuestion({ queued: 0, working: 0, tasks: Number.NaN, background: -2 }), null);
});

test("backgroundQuitWork: the tasks are the agent's count, the rest of its busy turns less this window's chats are channel replies", () => {
  assert.deepEqual(backgroundQuitWork(2, { tasks: 1, busyTurns: 4 }), { tasks: 1, background: 1 });
  // Nothing beyond the window's own chats: no background work invented.
  assert.deepEqual(backgroundQuitWork(2, { tasks: 0, busyTurns: 2 }), { tasks: 0, background: 0 });
  // A task claimed before its turn began, or a chat the agent already closed: never below zero.
  assert.deepEqual(backgroundQuitWork(1, { tasks: 1, busyTurns: 0 }), { tasks: 1, background: 0 });
  // No answer, or an agent that cannot say: none.
  assert.deepEqual(backgroundQuitWork(0, { tasks: null, busyTurns: null }), { tasks: 0, background: 0 });
  // A Telegram reply with no window turn at all.
  assert.deepEqual(backgroundQuitWork(0, { tasks: null, busyTurns: 1 }), { tasks: 0, background: 1 });
});

test("busyTurnsOf reads /health, and reads nothing from an agent that cannot say", () => {
  assert.equal(busyTurnsOf({ ok: true, busyTurns: 2 }), 2);
  assert.equal(busyTurnsOf({ ok: true }), null);
  assert.equal(busyTurnsOf({ busyTurns: "2" }), null);
  assert.equal(busyTurnsOf(null), null);
  assert.equal(busyTurnsOf(undefined), null);
});

test("sampleAgentBusy asks both at once and hands back what came", async () => {
  const sample = await sampleAgentBusy({ tasks: async () => 1, busyTurns: async () => 3 });
  assert.deepEqual(sample, { tasks: 1, busyTurns: 3 });
});

test("sampleAgentBusy: an answer that does not come in time, or fails, is none, and the quit is not held", async () => {
  const never = () => new Promise(() => {});
  const t0 = Date.now();
  const sample = await sampleAgentBusy({ tasks: never, busyTurns: async () => { throw new Error("gone"); } }, 40);
  assert.deepEqual(sample, { tasks: null, busyTurns: null });
  assert.ok(Date.now() - t0 < 1_000, "the bound, not the stalled probe, decided when it answered");
  // A probe that throws synchronously is a failed ask too, not a crash of the quit.
  const thrown = await sampleAgentBusy({ tasks: () => { throw new Error("sync"); }, busyTurns: async () => 0 }, 40);
  assert.deepEqual(thrown, { tasks: null, busyTurns: 0 });
  assert.ok(QUIT_PROBE_MS > 0 && QUIT_PROBE_MS <= 3_000, "a quit waits for the agent for a moment, not for long");
});
