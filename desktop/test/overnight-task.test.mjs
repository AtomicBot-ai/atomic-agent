// Unit tests for main/overnight-task.ts and the overnight_started event
// (ATO-1113), against the built output. Run: npm run build && npm run test:unit
//
// What the Run overnight dialog sends becomes the agent's POST /api/tasks
// body: the task in a new session in the chosen folder, the budget and the
// time limit under the group 1 contract's names, Telegram only when asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const O = require("../out/main/overnight-task.js");
const V = require("../out/main/analytics/validate.js");

const base = { message: "  fix the tests  ", folder: "/Users/me/app", maxCostUsd: 5, hours: 8, notifyTelegram: true };

test("a full request becomes the task body", () => {
  const r = O.overnightTaskBody(base);
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, {
    userMessage: "fix the tests",
    workingDir: "/Users/me/app",
    maxCostUsd: 5,
    maxDurationMs: 8 * 60 * 60 * 1000,
    notify: "telegram",
  });
});

test("no budget, 0 and an empty field all mean no cap; Telegram off sends no notify", () => {
  for (const maxCostUsd of [null, undefined, "", 0]) {
    const r = O.overnightTaskBody({ ...base, maxCostUsd, notifyTelegram: false });
    assert.equal(r.ok, true);
    assert.equal(r.body.maxCostUsd, null);
    assert.equal("notify" in r.body, false);
  }
  assert.equal(O.overnightTaskBody({ ...base, maxCostUsd: 2.345 }).body.maxCostUsd, 2.35);
});

test("refusals are sentences for the dialog", () => {
  assert.match(O.overnightTaskBody({ ...base, message: "   " }).error, /what the agent should do/);
  assert.match(O.overnightTaskBody({ ...base, message: "x".repeat(16_001) }).error, /too long/);
  assert.match(O.overnightTaskBody({ ...base, folder: "relative/dir" }).error, /Choose a folder/);
  assert.match(O.overnightTaskBody({ ...base, folder: "" }).error, /Choose a folder/);
  assert.match(O.overnightTaskBody({ ...base, hours: 0 }).error, /time limit/);
  assert.match(O.overnightTaskBody({ ...base, hours: 25 }).error, /time limit/);
  assert.match(O.overnightTaskBody({ ...base, maxCostUsd: -1 }).error, /budget/);
  assert.match(O.overnightTaskBody({ ...base, maxCostUsd: "lots" }).error, /budget/);
  assert.equal(O.overnightTaskBody(null).ok, false);
});

test("overnight_started keeps only the limits' shape, never the task or the folder", () => {
  const v = V.validateEvent("overnight_started", { has_budget: true, hours: 8, notify_telegram: false, message: "secret", folder: "/x" }, "main");
  assert.deepEqual(v, { event: "overnight_started", props: { has_budget: true, hours: 8, notify_telegram: false } });
  assert.equal(V.validateEvent("overnight_started", { has_budget: true, hours: 8, notify_telegram: false }, "ui"), null);
});
