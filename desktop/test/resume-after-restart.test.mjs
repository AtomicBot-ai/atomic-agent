// ATO-2768: once main brought the agent back from a crash (ATO-767), the chat
// on screen gets the ATO-448 Continue row when the agent recorded its last
// turn as cut off. Before, that row was only added when a chat was opened.
// No deps, no build.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../renderer/resume-after-restart.js");
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const CUT_OFF = { status: "cancelled", lastError: "turn interrupted: the agent stopped before it finished" };

// renderer.js interruptedTurnOffer's rule, restated (its own test is resume-interrupted-turn.test.mjs).
function offerFor(data, live) {
  if (live || !data || data.status !== "cancelled" || data.lastError !== CUT_OFF.lastError) return null;
  return { id: "offer", k: "system", text: "cut off", act: "resume-turn" };
}

function setup({ data = CUT_OFF, ok = true, log, busy = false, pending = null, sid = "ses-1", onRead } = {}) {
  const S = { agentSession: sid, sessionId: sid, log: log || [{ id: "q", k: "user", text: "push" }], busy, pending };
  const calls = { reads: [], renders: 0 };
  const BR = {
    session: async (id) => {
      calls.reads.push(id);
      if (onRead) onRead(S);
      return ok ? { ok: true, data } : { ok: false, error: "down" };
    },
  };
  const deps = { S, BR, offerFor, render: () => { calls.renders++; } };
  return { S, calls, deps };
}

const offers = (S) => S.log.filter((x) => x.act === "resume-turn").length;

test("a chat the crash cut off gets the Continue row once", async () => {
  const w = setup();
  assert.equal(await R.offerResumeAfterRestart(w.deps), true);
  assert.deepEqual(w.calls.reads, ["ses-1"]);
  assert.equal(offers(w.S), 1);
  assert.equal(w.calls.renders, 1);
  assert.equal(await R.offerResumeAfterRestart(w.deps), false, "a second restart adds no second row");
  assert.equal(offers(w.S), 1);
});

test("a chat whose turn ended normally gets nothing", async () => {
  for (const data of [{ status: "completed", lastError: null }, { status: "cancelled", lastError: null }]) {
    const w = setup({ data });
    assert.equal(await R.offerResumeAfterRestart(w.deps), false);
    assert.equal(offers(w.S), 0);
    assert.equal(w.calls.renders, 0);
  }
});

test("a row already there is not added again", async () => {
  const w = setup({ log: [{ id: "o", k: "system", act: "resume-turn", text: "x" }] });
  assert.equal(await R.offerResumeAfterRestart(w.deps), false);
  assert.equal(offers(w.S), 1);
});

test("the person switched or started a chat while it was read", async () => {
  const other = setup({ onRead: (S) => { S.agentSession = "ses-2"; S.sessionId = "ses-2"; } });
  assert.equal(await R.offerResumeAfterRestart(other.deps), false);
  assert.equal(offers(other.S), 0);
  // openSession moves sessionId first and agentSession only once the chat loaded.
  const opening = setup({ onRead: (S) => { S.sessionId = "ses-2"; } });
  assert.equal(await R.offerResumeAfterRestart(opening.deps), false);
  assert.equal(offers(opening.S), 0);
  const fresh = setup({ onRead: (S) => { S.agentSession = null; S.sessionId = ""; } });
  assert.equal(await R.offerResumeAfterRestart(fresh.deps), false);
});

test("no chat open, a failed read, or a running turn: nothing", async () => {
  const none = setup({ sid: null });
  assert.equal(await R.offerResumeAfterRestart(none.deps), false);
  assert.deepEqual(none.calls.reads, []);
  const failed = setup({ ok: false });
  assert.equal(await R.offerResumeAfterRestart(failed.deps), false);
  assert.equal(offers(failed.S), 0);
  const busy = setup({ onRead: (S) => { S.busy = true; } });
  assert.equal(await R.offerResumeAfterRestart(busy.deps), false);
  const asking = setup({ pending: { approvalId: "a1" } });
  assert.equal(await R.offerResumeAfterRestart(asking.deps), false);
});

test("renderer.js asks for it on the restarted notice, and the page loads it first", () => {
  const r = src("../renderer/renderer.js");
  const at = r.indexOf("\nfunction autoRestartApply(");
  assert.ok(at >= 0);
  const body = r.slice(at, r.indexOf("\n}\n", at));
  const restarted = body.slice(body.indexOf("n.kind === 'restarted'"), body.indexOf("n.kind === 'gave_up'"));
  assert.match(restarted, /offerResumeAfterRestart\(\{S, BR, offerFor: interruptedTurnOffer, render\}\)/);
  const html = src("../renderer/index.html");
  const tag = html.indexOf('<script src="resume-after-restart.js"></script>');
  assert.ok(tag >= 0, "index.html loads resume-after-restart.js");
  assert.ok(tag < html.indexOf('<script src="renderer.js"></script>'), "before renderer.js");
});
