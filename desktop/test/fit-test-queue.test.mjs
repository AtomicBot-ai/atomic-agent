// ATO-1545: a model test (fit-test) holds the local model server. Messages that
// were already queued when the test started must wait for it too, not only
// newly typed ones (submit, ATO-1091). drainQueued() leaves them owed while
// fitHoldsSend() is true; fitStart() asks drainOwed() once the test is over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const fit = readFileSync(new URL("../renderer/fit-test.js", import.meta.url), "utf8");

function body(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, head + " is in the source");
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end);
}

test("drainQueued keeps the queue owed while a model test holds the server", () => {
  const b = body(renderer, "function drainQueued() {");
  const hold = b.indexOf("fitHoldsSend()");
  assert.ok(hold > 0, "drainQueued asks fitHoldsSend");
  assert.match(b.slice(hold - 80, hold + 80), /DRAIN_OWED = true; return;/);
  assert.ok(hold < b.indexOf("S.queued.shift()"), "the hold comes before a message leaves the queue");
});

test("the end of a model test lets the owed queue run", () => {
  const b = body(fit, "async function fitStart() {");
  const idle = b.indexOf("FIT.phase = 'idle'");
  const drain = b.indexOf("drainOwed()");
  assert.ok(idle > 0 && drain > idle, "drainOwed is asked after the phase is back to idle");
});

test("the hold is the same rule as for typed messages: cloud and custom backends go through", async () => {
  const { createRequire } = await import("node:module");
  const R = createRequire(import.meta.url)("../renderer/fit-test.js");
  assert.equal(R.fitHoldsSendFor("running", "local"), true);
  assert.equal(R.fitHoldsSendFor("cancelling", "local"), true);
  assert.equal(R.fitHoldsSendFor("running", "cloud"), false);
  assert.equal(R.fitHoldsSendFor("running", "custom"), false);
  assert.equal(R.fitHoldsSendFor("idle", "local"), false);
});
