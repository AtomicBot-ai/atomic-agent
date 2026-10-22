// Unit tests for renderer/dead-engine.js (ATO-771, ATO-772).
// Run: npm run test:unit
// A turn that failed because the managed local model is not running reads as
// "The local model isn't running." with Start model, from the agent's new
// `local_engine_down` reason or, on today's agent, from a refused connection
// on the local route. While the app's supervisor is bringing the server back,
// the row waits for it instead of offering a second start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const D = createRequire(import.meta.url)("../renderer/dead-engine.js");
const LOCAL = { local: true, replied: false };
const CLOUD = { local: false, replied: false };

test("the phrase is the decided one, with no em dash", () => {
  assert.equal(D.DEAD_ENGINE_LINE, "The local model isn't running.");
  for (const s of [D.DEAD_ENGINE_LINE, D.DEAD_ENGINE_WAIT, D.DEAD_ENGINE_BACK]) assert.doesNotMatch(s, /—/);
});

test("the agent's local_engine_down reason is read wherever the frame carries it", () => {
  const code = D.DEAD_ENGINE_REASON;
  assert.equal(code, "local_engine_down");
  for (const ev of [
    // The agent's frame (ATO-772): {error, category, code} under payload, as agent-client.ts forwards it.
    { kind: "error", error: "The local model isn't running.", category: "transport",
      payload: { error: "The local model isn't running.", category: "transport", code } },
    { kind: "error", error: "x", code },
    { kind: "error", error: "x", payload: { cause: { kind: code } } },
    { kind: "error", error: "x", payload: { reason: code } },
    { kind: "error", error: "x", payload: { category: code } },
  ]) {
    assert.equal(D.engineDownReasonIn(ev), true, JSON.stringify(ev));
    // The agent's own verdict holds on any route the window thinks it is on.
    assert.equal(D.engineDownOf(ev, CLOUD), "reason");
  }
  assert.equal(D.engineDownReasonIn({ kind: "error", error: "x", payload: { cause: { kind: "billing" } } }), false);
  assert.equal(D.engineDownReasonIn({ kind: "error", error: "fetch failed", payload: { error: "fetch failed", category: "transport" } }), false);
  assert.equal(D.engineDownReasonIn(null), false);
});

test("today's agent: a refused connection or 'not answering' on the local route", () => {
  assert.equal(D.engineDownOf({ error: "fetch failed: connect ECONNREFUSED 127.0.0.1:8080", category: "transport" }, LOCAL), "refused");
  assert.equal(D.engineDownOf({ error: "local-llama is not answering at 127.0.0.1:8080" }, LOCAL), "refused");
  // The agent's sentence without its code (a host that drops unknown fields) still reads right on the local route.
  assert.equal(D.engineDownOf({ error: "The local model isn't running." }, LOCAL), "refused");
});

test("the same words on a cloud or external route are not the local model", () => {
  assert.equal(D.engineDownOf({ error: "connect ECONNREFUSED 10.0.0.2:443" }, CLOUD), null);
  assert.equal(D.engineDownOf({ error: "connect ECONNREFUSED 127.0.0.1:8080" }, undefined), null);
});

test("an endpoint that answered with a status, or any other failure, is not a dead engine", () => {
  assert.equal(D.engineDownOf({ error: "ECONNREFUSED", category: "transport" }, { local: true, replied: true }), null);
  assert.equal(D.engineDownOf({ error: "the model returned an empty reply", category: "empty" }, LOCAL), null);
  assert.equal(D.engineDownOf({ error: "fetch failed" }, LOCAL), null);
  assert.equal(D.engineDownOf({ error: "" }, LOCAL), null);
});

test("the row offers Start model, waits on the supervisor's restart, and stops offering once it is back", () => {
  assert.equal(D.deadEngineOffer({}, null).kind, "start");
  // Automatic restarts gave up: the person starts it.
  assert.equal(D.deadEngineOffer({}, "gave_up").kind, "start");
  assert.equal(D.deadEngineOffer({}, "restarting").kind, "wait");
  assert.equal(D.deadEngineOffer({}, "restart_failed").kind, "wait");
  assert.equal(D.deadEngineOffer({}, "restarted").kind, "back");
  assert.equal(D.deadEngineOffer({ starting: true }, null).kind, "starting");
  assert.equal(D.deadEngineOffer({ starting: true }, "restarting").kind, "starting");
  assert.equal(D.deadEngineOffer({ started: true }, null).kind, "back");
});
