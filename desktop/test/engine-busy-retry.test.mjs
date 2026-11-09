// Unit tests for main/engine-busy-retry.ts, against the built output.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { engineBusy, retryWhileEngineBusy } = require("../out/main/engine-busy-retry.js");

const BUSY = { ok: false, error: "Another engine operation is running. Wait for it to finish." };
const STARTING = { ok: false, stderr: "Another engine operation is starting. Retry shortly." };
const FAILED = { ok: false, error: "Download failed: no network" };
const OK = { ok: true };

function script(...answers) {
  const calls = { n: 0 };
  return { calls, attempt: async () => answers[Math.min(calls.n++, answers.length - 1)] };
}
const live = () => new AbortController().signal;

test("both of the agent's lock refusals read as busy, nothing else does", () => {
  assert.equal(engineBusy(BUSY), true);
  assert.equal(engineBusy(STARTING), true);
  assert.equal(engineBusy(FAILED), false);
  assert.equal(engineBusy(OK), false);
  assert.equal(engineBusy({ ok: true, stderr: "Another engine operation is running." }), false);
});

test("a held lock is tried again until the install goes through", async () => {
  const { calls, attempt } = script(BUSY, STARTING, OK);
  const res = await retryWhileEngineBusy(attempt, { signal: live(), pollMs: 1 });
  assert.deepEqual(res, OK);
  assert.equal(calls.n, 3);
});

test("a real failure is returned at once, not retried", async () => {
  const { calls, attempt } = script(FAILED, OK);
  assert.deepEqual(await retryWhileEngineBusy(attempt, { signal: live(), pollMs: 1 }), FAILED);
  assert.equal(calls.n, 1);
});

test("a failure after a wait is returned as it came", async () => {
  const { calls, attempt } = script(BUSY, FAILED);
  assert.deepEqual(await retryWhileEngineBusy(attempt, { signal: live(), pollMs: 1 }), FAILED);
  assert.equal(calls.n, 2);
});

test("the wait ends at its limit with the last refusal", async () => {
  const { calls, attempt } = script(BUSY);
  const res = await retryWhileEngineBusy(attempt, { signal: live(), waitMs: 30, pollMs: 5 });
  assert.deepEqual(res, BUSY);
  assert.ok(calls.n > 1, "it tried more than once");
});

test("a stop during the wait ends it at once, with no further attempt", async () => {
  const stop = new AbortController();
  const { calls, attempt } = script(BUSY, OK);
  const began = Date.now();
  const running = retryWhileEngineBusy(attempt, { signal: stop.signal, pollMs: 60_000 });
  setTimeout(() => stop.abort(), 10);
  assert.deepEqual(await running, BUSY);
  assert.equal(calls.n, 1);
  assert.ok(Date.now() - began < 5_000, "it did not sit out the pause");
});

test("every lock refusal the agent can give is recognised", () => {
  const source = readFileSync(new URL("../../src/local-llm/core/core-operation.ts", import.meta.url), "utf8");
  const refusals = [...source.matchAll(/new CoreOperationBusyError\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.equal(refusals.length, 2, "the agent's refusals were found");
  for (const error of refusals) assert.equal(engineBusy({ ok: false, error }), true, error);
});

test("the launch and setup installs wait, Settings' does not, and a stop during the wait reads as stopped", () => {
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  const body = main.slice(main.indexOf("function engineInstallStream("), main.indexOf("pullUpdate = slot = { done"));
  assert.ok(body.length > 0, "the install was found");
  assert.match(body, /via === "settings" \? attempt\(\) : retryWhileEngineBusy\(attempt, \{ signal: own\.signal \}\)/);
  assert.match(body, /own\.signal\.aborted && engineBusy\(ended\)\) return stopped\(UPDATE_STOPPED\)/);
});

test("a stop made before the refusal comes back is not retried", async () => {
  const stop = new AbortController();
  stop.abort();
  const { calls, attempt } = script(BUSY, OK);
  assert.deepEqual(await retryWhileEngineBusy(attempt, { signal: stop.signal, pollMs: 1 }), BUSY);
  assert.equal(calls.n, 1);
});
