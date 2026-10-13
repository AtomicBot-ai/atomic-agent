// Unit tests for main/quit-shutdown.ts, against the built output.
// Run: npm run build && npm run test:unit
// The quit's shutdown (before-quit) must end in bounded time whatever a step
// does, and the model server's stop must still run after an agent close that
// never settles (T30: the app outlived 30 s with `models stop` never run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { runQuitShutdown, settleWithin } = require("../out/main/quit-shutdown.js");

const never = () => new Promise(() => {});

test("the steps run in order: close, then the model server's stop, then the flush", async () => {
  const order = [];
  const outcome = await runQuitShutdown({
    closeAgent: async () => { order.push("close"); },
    stopModelServer: async () => { order.push("stop"); },
    flush: async () => { order.push("flush"); },
  }, { closeMs: 1_000, totalMs: 2_000 });
  assert.equal(outcome, "done");
  assert.deepEqual(order, ["close", "stop", "flush"]);
});

test("an agent close that never settles does not keep the model server's stop from running", async () => {
  const order = [];
  const started = Date.now();
  const outcome = await runQuitShutdown({
    closeAgent: never,
    stopModelServer: async () => { order.push("stop"); },
    flush: async () => { order.push("flush"); },
  }, { closeMs: 50, totalMs: 2_000 });
  assert.equal(outcome, "done");
  assert.deepEqual(order, ["stop", "flush"]);
  assert.ok(Date.now() - started < 1_000, "waited past the close bound");
});

test("a failing or throwing step does not stop the ones after it", async () => {
  const order = [];
  const outcome = await runQuitShutdown({
    closeAgent: () => { throw new Error("sync throw"); },
    stopModelServer: async () => { order.push("stop"); throw new Error("stop failed"); },
    flush: async () => { order.push("flush"); },
  }, { closeMs: 1_000, totalMs: 2_000 });
  assert.equal(outcome, "done");
  assert.deepEqual(order, ["stop", "flush"]);
});

test("a step that never settles is cut off by the ceiling, so the quit always goes on", async () => {
  const started = Date.now();
  const outcome = await runQuitShutdown({
    closeAgent: async () => {},
    stopModelServer: never,
    flush: async () => {},
  }, { closeMs: 50, totalMs: 120 });
  assert.equal(outcome, "timed-out");
  assert.ok(Date.now() - started < 1_000, "waited past the ceiling");
});

test("settleWithin answers the value, or the fallback on time-out or rejection", async () => {
  assert.equal(await settleWithin(Promise.resolve(7), 1_000, null), 7);
  assert.equal(await settleWithin(never(), 20, null), null);
  assert.equal(await settleWithin(Promise.reject(new Error("x")), 1_000, "fallback"), "fallback");
});
