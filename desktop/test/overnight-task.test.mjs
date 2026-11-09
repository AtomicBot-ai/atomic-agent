// Unit tests for main/overnight-task.ts and the overnight_started event
// (ATO-1113), against the built output. Run: npm run build && npm run test:unit
//
// What the Run overnight dialog sends becomes the agent's POST /api/tasks
// body: the task in a new session in the chosen folder, the budget and the
// time limit under the group 1 contract's names, Telegram only when asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

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
    maxSteps: O.OVERNIGHT_MAX_STEPS,
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

test("a remote agent gets its own folder, never the one from this computer", () => {
  const r = O.overnightTaskBody(base, "/srv/agent");
  assert.equal(r.ok, true);
  assert.equal(r.body.workingDir, "/srv/agent");
  // The dialog has no folder to give, and the path is the other computer's, so this one's rules do not judge it.
  assert.equal(O.overnightTaskBody({ ...base, folder: "" }, "/srv/agent").body.workingDir, "/srv/agent");
  assert.equal(O.overnightTaskBody(base, "C:\\work").body.workingDir, "C:\\work");
  // Everything else is still checked.
  assert.match(O.overnightTaskBody({ ...base, message: " " }, "/srv/agent").error, /what the agent should do/);
});

test("the remote folder comes from the agent's health answer", () => {
  assert.equal(O.remoteAgentFolder({ workingDir: " /srv/agent " }), "/srv/agent");
  assert.equal(O.remoteAgentFolder({ workingDir: "" }), null);
  assert.equal(O.remoteAgentFolder({ workingDir: 42 }), null);
  assert.equal(O.remoteAgentFolder({}), null);
  assert.equal(O.remoteAgentFolder(null), null);
});

test("a remote agent without the workingDir route is named as the problem", () => {
  const raw = "sessionId and userMessage are required strings";
  assert.match(O.overnightErrorText(raw, true), /cannot take Run overnight from another computer/);
  assert.equal(O.overnightErrorText(raw, false), raw);
  assert.equal(O.overnightErrorText("workingDir does not exist", true), "workingDir does not exist");
});

test("overnight:start reads the remote agent's folder before building the body", () => {
  const ipc = readFileSync(new URL("../main/overnight-ipc.ts", import.meta.url), "utf8");
  assert.match(ipc, /if \(deps\.client\.isRemote\)/);
  assert.match(ipc, /remoteAgentFolder\(await deps\.client\.turnsHealth\(\)/);
  assert.match(ipc, /overnightTaskBody\(input, remoteFolder\)/);
});

test("overnight_started keeps only the limits' shape, never the task or the folder", () => {
  const v = V.validateEvent("overnight_started", { has_budget: true, hours: 8, notify_telegram: false, message: "secret", folder: "/x" }, "main");
  assert.deepEqual(v, { event: "overnight_started", props: { has_budget: true, hours: 8, notify_telegram: false } });
  assert.equal(V.validateEvent("overnight_started", { has_budget: true, hours: 8, notify_telegram: false }, "ui"), null);
});
