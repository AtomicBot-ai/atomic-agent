// Unit tests for ATO-2519 (main/quit-busy-origins.ts and its hook in
// main/quit-question.ts), against the built output.
// Run: npm run build && npm run test:unit
// ATO-1758 got channel replies by subtraction and said "a reply in Telegram
// or another channel" for all of them, an API request included. An agent with
// ATO-2519 lists each busy turn's origin on /health, and the quit question
// names it. Every test here fails on the ATO-1758 code alone: the module did
// not exist, sampleAgentBusy had no `health` probe and backgroundQuitWork
// returned no `named` list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { busyOriginsOf, namedBackgroundWork } = require("../out/main/quit-busy-origins.js");
const { quitQuestion, backgroundQuitWork, sampleAgentBusy } = require("../out/main/quit-question.js");

const o = (...origins) => origins.map((origin) => ({ origin }));

test("busyOriginsOf reads /health busyTurnOrigins, and nothing from an older agent", () => {
  assert.deepEqual(busyOriginsOf({ busyTurns: 2, busyTurnOrigins: [{ origin: "telegram" }, { origin: "scheduler", wakeReason: "webhook" }] }),
    [{ origin: "telegram" }, { origin: "scheduler", wakeReason: "webhook" }]);
  assert.deepEqual(busyOriginsOf({ busyTurns: 0, busyTurnOrigins: [] }), []);
  // An agent before ATO-2519: no list, so the caller keeps the old words.
  assert.equal(busyOriginsOf({ busyTurns: 1 }), null);
  assert.equal(busyOriginsOf(null), null);
  assert.equal(busyOriginsOf({ busyTurnOrigins: "telegram" }), null);
  // Junk entries are skipped, not fatal.
  assert.deepEqual(busyOriginsOf({ busyTurnOrigins: [null, { origin: 3 }, { origin: "" }, { origin: "discord", wakeReason: 1 }] }), [{ origin: "discord" }]);
});

test("a Telegram reply alone is named as Telegram, not 'Telegram or another channel'", () => {
  const work = backgroundQuitWork(0, { tasks: 0, busyTurns: 1, origins: o("telegram") });
  assert.equal(work.background, 1);
  assert.deepEqual(quitQuestion({ queued: 0, working: 0, ...work }), {
    message: "A reply in Telegram is still being written",
    detail: "Quitting now cuts it off before it is sent.",
  });
  const two = quitQuestion({ queued: 0, working: 0, ...backgroundQuitWork(0, { tasks: 0, busyTurns: 2, origins: o("discord", "discord") }) });
  assert.equal(two.message, "2 replies in Discord are still being written");
  assert.match(two.detail, /cuts them off before they are sent\./);
});

test("an API request is named as one, after this window's own chats are taken out", () => {
  // Two http turns, one of them this window's chat: one API request.
  const work = backgroundQuitWork(1, { tasks: 0, busyTurns: 2, origins: o("http", "http") });
  assert.deepEqual(quitQuestion({ queued: 0, working: 1, ...work }), {
    message: "Atomic Agent is still working",
    detail: "Still running: a chat and an API request. Quitting now stops all of it before it is done.",
  });
  const alone = quitQuestion({ queued: 0, working: 0, ...backgroundQuitWork(0, { tasks: null, busyTurns: 1, origins: o("http") }) });
  assert.deepEqual(alone, { message: "An API request is still being answered", detail: "Quitting now cuts its answer off before it is done." });
  // The window's chats alone: no API request invented.
  assert.deepEqual(backgroundQuitWork(2, { tasks: 0, busyTurns: 2, origins: o("http", "http") }), { tasks: 0, background: 0, named: [] });
});

test("several channels at once: each named, in the order the agent listed them", () => {
  const work = backgroundQuitWork(0, { tasks: 1, busyTurns: 5, origins: o("slack", "telegram", "scheduler", "slack", "msteams") });
  const q = quitQuestion({ queued: 1, working: 0, ...work });
  assert.equal(q.message, "Atomic Agent is still working");
  assert.equal(q.detail, "Still running: a scheduled task, 2 replies in Slack, a reply in Telegram and a reply in Microsoft Teams. Quitting now stops all of it before it is done. A queued message is dropped too.");
});

test("task turns and worker turns are not counted twice; an unknown origin is still asked about", () => {
  // scheduler: the task list counts it. fusion/subagent: a worker of another turn.
  assert.deepEqual(namedBackgroundWork(0, o("scheduler", "fusion", "subagent")), []);
  assert.equal(quitQuestion({ queued: 0, working: 0, ...backgroundQuitWork(0, { tasks: 0, busyTurns: 3, origins: o("scheduler", "fusion", "subagent") }) }), null);
  const other = namedBackgroundWork(0, o("cli", "somethingnew"));
  assert.equal(other.length, 1);
  assert.equal(other[0].item, "other agent work");
  assert.equal(other[0].n, 2);
  assert.equal(quitQuestion({ queued: 0, working: 0, named: other }).message, "Other agent work is still running");
});

test("an older agent (no origins) keeps the ATO-1758 arithmetic and words", () => {
  const work = backgroundQuitWork(1, { tasks: 0, busyTurns: 2 });
  assert.deepEqual(work, { tasks: 0, background: 1 });
  assert.equal(quitQuestion({ queued: 0, working: 0, ...work }).message, "A reply in Telegram or another channel is still being written");
  const nullOrigins = backgroundQuitWork(0, { tasks: 0, busyTurns: 1, origins: null });
  assert.deepEqual(nullOrigins, { tasks: 0, background: 1 });
});

test("sampleAgentBusy with a health probe reads busyTurns and busyTurnOrigins from one answer", async () => {
  let asked = 0;
  const sample = await sampleAgentBusy({
    tasks: async () => 1,
    health: async () => { asked += 1; return { busyTurns: 2, busyTurnOrigins: [{ origin: "telegram" }, { origin: "scheduler" }] }; },
  });
  assert.equal(asked, 1);
  assert.deepEqual(sample, { tasks: 1, busyTurns: 2, origins: [{ origin: "telegram" }, { origin: "scheduler" }] });
  // An older agent's /health: the count, and no origins.
  assert.deepEqual(await sampleAgentBusy({ tasks: async () => 0, health: async () => ({ busyTurns: 1 }) }), { tasks: 0, busyTurns: 1, origins: null });
  // No answer in time: none of either, and the quit is not held.
  const never = () => new Promise(() => {});
  assert.deepEqual(await sampleAgentBusy({ tasks: async () => null, health: never }, 40), { tasks: null, busyTurns: null, origins: null });
});

test("a task still asks when /api/tasks gave no answer: scheduler origins count as tasks then", () => {
  const work = backgroundQuitWork(0, { tasks: null, busyTurns: 1, origins: o("scheduler") });
  assert.equal(work.tasks, 1);
  assert.notEqual(quitQuestion({ queued: 0, working: 0, ...work }), null, "the quit asks before it stops the task");
  // With an answer from /api/tasks the scheduler turn is not counted twice.
  assert.equal(backgroundQuitWork(0, { tasks: 1, busyTurns: 1, origins: o("scheduler") }).tasks, 1);
  assert.equal(backgroundQuitWork(0, { tasks: 0, busyTurns: 1, origins: o("scheduler") }).tasks, 0);
});
