// ATO-2391: the desktop pet's state machine (main/pet-state.ts): priorities,
// the minimum time a state stays, done / error going back to idle, sleeping,
// do not disturb, and the view the page draws.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PetMachine, PET_PRIORITY, PET_TIMING, petView } = require("../out/main/pet-state.js");

const quiet = { activity: null, waiting: false };

test("priorities: waiting beats error beats working beats thinking beats done beats idle beats sleeping", () => {
  const order = ["waiting", "error", "working", "thinking", "done", "idle", "sleeping"];
  for (let i = 1; i < order.length; i++) assert.ok(PET_PRIORITY[order[i - 1]] > PET_PRIORITY[order[i]], `${order[i - 1]} > ${order[i]}`);
});

test("starts idle; a turn thinking, then a tool call, shows thinking then working", () => {
  const m = new PetMachine(0);
  assert.equal(m.step(quiet, 0).state, "idle");
  assert.equal(m.step({ activity: "thinking", waiting: false }, 10).state, "thinking");
  assert.equal(m.step({ activity: "working", waiting: false }, 20).state, "working");
});

test("an approval request shows at once, over a tool call", () => {
  const m = new PetMachine(0);
  m.step({ activity: "working", waiting: false }, 0);
  assert.equal(m.step({ activity: "working", waiting: true }, 5).state, "waiting");
});

test("a lower state waits out the minimum display time, and says when to look again", () => {
  const m = new PetMachine(0);
  m.step({ activity: "working", waiting: false }, 1000);
  const held = m.step({ activity: "thinking", waiting: false }, 1100);
  assert.equal(held.state, "working", "no flicker back to thinking after 100 ms");
  assert.equal(held.nextAt, 1000 + PET_TIMING.minShowMs);
  assert.equal(m.step({ activity: "thinking", waiting: false }, 1000 + PET_TIMING.minShowMs).state, "thinking");
});

test("done shows after the turn, then goes back to idle by itself", () => {
  const m = new PetMachine(0);
  m.step({ activity: "thinking", waiting: false }, 0);
  m.ended("done", 5000);
  const s = m.step(quiet, 5000);
  assert.equal(s.state, "done");
  assert.equal(s.nextAt, 5000 + PET_TIMING.doneMs);
  assert.equal(m.step(quiet, 5000 + PET_TIMING.doneMs).state, "idle");
});

test("error shows longer than done and beats a running turn", () => {
  const m = new PetMachine(0);
  m.step({ activity: "working", waiting: false }, 0);
  m.ended("error", 1000);
  assert.equal(m.step({ activity: "working", waiting: false }, 1000).state, "error");
  // A later done of another turn does not cover a fresh error.
  m.ended("done", 2000);
  assert.equal(m.step(quiet, 2000).state, "error");
  assert.equal(m.step(quiet, 1000 + PET_TIMING.errorMs).state, "idle");
});

test("a turn the person stopped shows nothing", () => {
  const m = new PetMachine(0);
  m.step({ activity: "thinking", waiting: false }, 0);
  m.ended("stopped", 1000);
  assert.equal(m.step(quiet, 1000).state, "idle");
});

test("done hides under another turn that is still running", () => {
  const m = new PetMachine(0);
  m.step({ activity: "working", waiting: false }, 0);
  m.ended("done", 1000);
  assert.equal(m.step({ activity: "working", waiting: false }, 1000).state, "working");
});

test("sleeps after a quiet stretch, wakes at once for work", () => {
  const m = new PetMachine(0);
  const first = m.step(quiet, 0);
  assert.equal(first.nextAt, PET_TIMING.sleepAfterMs, "it looks again when sleep is due");
  assert.equal(m.step(quiet, PET_TIMING.sleepAfterMs).state, "sleeping");
  assert.equal(m.step({ activity: "thinking", waiting: false }, PET_TIMING.sleepAfterMs + 1).state, "thinking");
});

test("do not disturb: no done / error flashes, waiting still shows", () => {
  const m = new PetMachine(0);
  m.setDoNotDisturb(true);
  m.step({ activity: "thinking", waiting: false }, 0);
  m.ended("error", 1000);
  assert.equal(m.step(quiet, 1000 + PET_TIMING.minShowMs).state, "idle");
  assert.equal(m.step({ activity: null, waiting: true }, 3000).state, "waiting");
  assert.equal(m.doNotDisturb, true);
});

const req = (id) => ({ approvalId: id, sessionId: "s", tool: "shell", text: "ls", risk: "", question: false, canAllow: true, seenAt: 0 });

test("the view carries the oldest request while waiting, and none in do not disturb", () => {
  const v = petView("waiting", false, [req("a"), req("b")]);
  assert.equal(v.approval.approvalId, "a");
  assert.equal(v.more, 1);
  assert.match(v.label, /waiting for you/);
  const q = petView("waiting", true, [req("a")]);
  assert.equal(q.approval, null, "no bubble in do not disturb");
  assert.match(q.label, /do not disturb/);
  assert.equal(petView("working", false, [req("a")]).approval, null, "only the waiting state has a bubble");
});
