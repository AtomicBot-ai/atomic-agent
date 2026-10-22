// Unit tests for main/agent-auto-restart.ts (ATO-767), against the built output.
// Run: npm run build && npm run test:unit
// An agent that exits on its own while running is started again: up to three
// attempts within five minutes, after 1 s, 5 s and 20 s; the count is
// forgotten after ten minutes of normal running; a deliberate stop drops a
// waiting attempt; after the third failure it stops and the window offers
// the Restart agent button.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  AgentAutoRestart,
  AUTO_RESTART_DELAYS_MS,
  AUTO_RESTART_WINDOW_MS,
  AUTO_RESTART_RESET_MS,
  AGENT_RESTARTED_LINE,
  AGENT_GAVE_UP_LINE,
} = require("../out/main/agent-auto-restart.js");

const settle = () => new Promise((r) => setImmediate(r));

/** A restarter on stand-ins: the test answers each start and moves the clock. */
function standIn({ answer = "connected" } = {}) {
  const f = { clock: 1_000_000, timers: [], starts: [], notices: [], answer };
  const r = new AgentAutoRestart({
    start: async (attempt) => {
      f.starts.push(attempt);
      return { state: typeof f.answer === "function" ? f.answer(attempt) : f.answer };
    },
    notify: (n) => f.notices.push(n),
    now: () => f.clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      f.timers.push(t);
      return t;
    },
    clearTimer: (t) => { t.live = false; },
  });
  /** Moves the clock by the next live timer's pause and runs it. */
  f.tick = async () => {
    const t = f.timers.find((x) => x.live);
    assert.ok(t, "a timer is waiting");
    t.live = false;
    f.clock += t.ms;
    t.fn();
    await settle();
    return t.ms;
  };
  f.kinds = () => f.notices.map((n) => n.kind);
  return { r, f };
}

test("the pauses are 1 s, 5 s and 20 s, within five minutes, reset after ten", () => {
  assert.deepEqual([...AUTO_RESTART_DELAYS_MS], [1000, 5000, 20000]);
  assert.equal(AUTO_RESTART_WINDOW_MS, 300_000);
  assert.equal(AUTO_RESTART_RESET_MS, 600_000);
});

test("an exit while running is started again after 1 s and said once it is back", async () => {
  const { r, f } = standIn();
  assert.equal(r.exited("running"), "scheduled");
  assert.equal(r.pending(), true);
  assert.deepEqual(f.starts, [], "nothing starts before the pause");
  assert.equal(await f.tick(), 1000);
  assert.deepEqual(f.starts, [1]);
  assert.deepEqual(f.kinds(), ["scheduled", "restarted"]);
  assert.equal(r.attemptsMade(), 1);
});

test("an exit while booting, or with the restarter off, is not an attempt", () => {
  const { r, f } = standIn();
  assert.equal(r.exited("starting"), "ignored");
  r.arm(false);
  assert.equal(r.exited("running"), "ignored");
  assert.equal(f.timers.length, 0);
});

test("three failed attempts after 1 s, 5 s and 20 s, then it stops and gives up", async () => {
  const { r, f } = standIn({ answer: "error" });
  r.exited("running");
  const pauses = [await f.tick(), await f.tick(), await f.tick()];
  assert.deepEqual(pauses, [1000, 5000, 20000]);
  assert.deepEqual(f.starts, [1, 2, 3]);
  assert.equal(f.kinds().at(-1), "gave_up");
  assert.equal(f.timers.filter((t) => t.live).length, 0, "no fourth attempt is waiting");
});

test("killed four times in a row: three restarts, the fourth exit gives up", async () => {
  const { r, f } = standIn();
  for (let i = 0; i < 3; i++) {
    assert.equal(r.exited("running"), "scheduled");
    await f.tick();
    f.clock += 5_000;   // runs a few seconds, then is killed again
  }
  assert.deepEqual(f.starts, [1, 2, 3]);
  assert.equal(r.exited("running"), "gave_up");
  assert.equal(f.kinds().filter((k) => k === "restarted").length, 3);
  assert.equal(f.kinds().at(-1), "gave_up");
});

test("ten minutes of normal running forgets the count", async () => {
  const { r, f } = standIn();
  r.exited("running");
  await f.tick();                       // restarted; the reset timer is armed
  const reset = f.timers.find((t) => t.live);
  assert.equal(reset.ms, AUTO_RESTART_RESET_MS);
  await f.tick();
  assert.equal(r.attemptsMade(), 0);
  assert.equal(f.kinds().at(-1), "reset");
  r.exited("running");
  assert.equal(f.timers.find((t) => t.live).ms, 1000, "the ladder starts again at 1 s");
});

test("a crash before the ten minutes keeps the count; attempts older than five minutes do not count", async () => {
  const { r, f } = standIn();
  r.exited("running");
  await f.tick();
  f.clock += 60_000;
  r.exited("running");
  assert.equal(f.timers.find((t) => t.live).ms, 5000, "second attempt within five minutes waits 5 s");
  await f.tick();
  f.clock += AUTO_RESTART_WINDOW_MS + 1;   // the earlier attempts left the window, before any reset fired
  r.exited("running");
  assert.equal(f.timers.find((t) => t.live).ms, 1000);
});

test("a deliberate stop during the pause drops the attempt", async () => {
  const { r, f } = standIn();
  r.exited("running");
  r.cancel();
  assert.equal(r.pending(), false);
  assert.equal(f.timers.filter((t) => t.live).length, 0);
  assert.deepEqual(f.starts, []);
  assert.equal(f.kinds().at(-1), "reset");
});

test("a stop while an attempt starts: no verdict and no next attempt", async () => {
  let release;
  const f = { starts: [], notices: [], timers: [] };
  const r = new AgentAutoRestart({
    start: (attempt) => { f.starts.push(attempt); return new Promise((res) => { release = res; }); },
    notify: (n) => f.notices.push(n.kind),
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; f.timers.push(t); return t; },
    clearTimer: (t) => { t.live = false; },
  });
  r.exited("running");
  f.timers[0].live = false;
  f.timers[0].fn();
  r.cancel();
  release({ state: "error" });   // the quit's stop answered while it started
  await settle();
  assert.deepEqual(f.starts, [1]);
  assert.deepEqual(f.notices, ["scheduled", "reset"]);
  assert.equal(f.timers.filter((t) => t.live).length, 0);
});

test("a start that gave way to a stop is not a failure", async () => {
  const { r, f } = standIn({ answer: "stopped" });
  r.exited("running");
  await f.tick();
  assert.deepEqual(f.kinds(), ["scheduled"]);
  assert.equal(f.timers.filter((t) => t.live).length, 0);
});

test("the window's words are main's, without em dashes", () => {
  const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  for (const line of [AGENT_RESTARTED_LINE, AGENT_GAVE_UP_LINE]) {
    assert.ok(renderer.includes(`'${line}'`), line);
    assert.ok(!line.includes("—"), line);
  }
  assert.equal(AGENT_RESTARTED_LINE, "The agent stopped unexpectedly and was restarted.");
  assert.ok(renderer.includes('data-act="agent:restart">Restart agent</button>'));
});
