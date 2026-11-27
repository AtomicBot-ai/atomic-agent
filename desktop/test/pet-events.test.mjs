// ATO-2391: the desktop pet reads the agent's frames (main/pet-events.ts):
// turn activity, how a turn ended, the waiting requests and what the bubble
// may offer for each. The pet never allows what the full card should decide.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PetTracker, petApprovalFrom, petCanAllow, petDecision, petClean, petRiskLine, PET_TURN_STALE_MS } = require("../out/main/pet-events.js");

const frame = (turnId, kind, extra = {}) => ({ turnId, kind, ...extra });

test("a turn thinks, works during a tool call, and ends done", () => {
  const t = new PetTracker();
  assert.equal(t.activity(0), null);
  assert.equal(t.observeChat(frame("t1", "session_id", { payload: { sessionId: "s1" } }), 0), null);
  assert.equal(t.activity(0), "thinking");
  t.observeChat(frame("t1", "tool_progress", { payload: { tool: "fs.read" } }), 1);
  assert.equal(t.activity(1), "working");
  t.observeChat(frame("t1", "delta", { text: "ok" }), 2);
  assert.equal(t.activity(2), "thinking");
  assert.equal(t.observeChat(frame("t1", "done"), 3), "done");
  assert.equal(t.activity(3), null);
});

test("working beats thinking across two turns", () => {
  const t = new PetTracker();
  t.observeChat(frame("a", "reasoning_progress"), 0);
  t.observeChat(frame("b", "tool_progress"), 0);
  assert.equal(t.activity(0), "working");
});

test("an error frame then done is a failed turn; work after the error makes it done", () => {
  const t = new PetTracker();
  t.observeChat(frame("a", "error", { error: "boom", payload: {} }), 0);
  assert.equal(t.observeChat(frame("a", "done"), 1), "error");
  t.observeChat(frame("b", "error", { error: "retry", payload: {} }), 0);
  t.observeChat(frame("b", "delta", { text: "recovered" }), 1);
  assert.equal(t.observeChat(frame("b", "done"), 2), "done");
});

test("aborted is stopped; a bare error ends the turn as an error", () => {
  const t = new PetTracker();
  t.observeChat(frame("a", "delta"), 0);
  assert.equal(t.observeChat(frame("a", "aborted"), 1), "stopped");
  assert.equal(t.observeChat(frame("b", "error", { error: "HTTP 500" }), 1), "error");
});

test("a turn silent for too long stops counting as running", () => {
  const t = new PetTracker();
  t.observeChat(frame("a", "delta"), 0);
  assert.equal(t.activity(PET_TURN_STALE_MS + 1), null);
});

const ask = (over = {}) => ({ approvalId: "ap-1", sessionId: "s1", tool: "shell.exec", category: "shell", reason: "run ls -la", preview: "ls -la", ...over });

test("a request is kept once, replays do not reopen an answered one", () => {
  const t = new PetTracker();
  assert.equal(t.observeApproval(ask(), 10), true);
  assert.equal(t.observeApproval(ask(), 11), false, "the same request again is not new");
  assert.equal(t.pending().length, 1);
  assert.equal(t.approvalAnswered("ap-1"), true);
  assert.equal(t.observeApproval(ask(), 12), false, "a replay of an answered request stays closed");
  assert.equal(t.pending().length, 0);
});

test("the turn's end drops its chat's requests", () => {
  const t = new PetTracker();
  t.observeChat(frame("t1", "session_id", { payload: { session_id: "s1" } }), 0);
  t.observeApproval(ask(), 1);
  t.observeApproval(ask({ approvalId: "other", sessionId: "s2" }), 1);
  t.observeChat(frame("t1", "done"), 2);
  assert.deepEqual(t.pending().map((a) => a.approvalId), ["other"]);
});

test("not an approval: no id, or an id that could be markup", () => {
  assert.equal(petApprovalFrom({ tool: "x" }, 0), null);
  assert.equal(petApprovalFrom({ approvalId: "<img src=x>" }, 0), null);
  assert.equal(petApprovalFrom(null, 0), null);
});

test("the bubble's words: one clean line, clipped", () => {
  const a = petApprovalFrom(ask({ reason: "line one\nline\u0007 two" }), 0);
  assert.equal(a.text, "line one line two");
  assert.equal(petClean("x".repeat(300)).length, 140);
  assert.equal(petApprovalFrom(ask({ reason: "", preview: "first\nsecond" }), 0).text, "first");
  assert.equal(petRiskLine({ riskLevel: "medium", riskReason: "installs a package" }), "Risk check: medium. Installs a package");
  assert.equal(petRiskLine({ riskLevel: "bogus" }), "");
});

test("Allow is offered only for an ordinary request", () => {
  assert.equal(petCanAllow({ category: "shell" }), true);
  assert.equal(petCanAllow({ category: "shell", riskLevel: "high" }), false, "a high risk verdict needs the full card");
  assert.equal(petCanAllow({ category: "shell_dangerous" }), false);
  assert.equal(petCanAllow({ category: "trust_config" }), false);
  assert.equal(petCanAllow({ category: "user_question" }), false);
  const q = petApprovalFrom(ask({ category: "user_question" }), 0);
  assert.equal(q.question, true);
  assert.equal(q.canAllow, false);
});

test("petDecision: allow-once or deny for the shown request, nothing else", () => {
  const shown = petApprovalFrom(ask(), 0);
  assert.deepEqual(petDecision({ approvalId: "ap-1", decision: "allow" }, shown), { decision: "allow-once" });
  assert.deepEqual(petDecision({ approvalId: "ap-1", decision: "deny" }, shown), { decision: "deny" });
  assert.ok("error" in petDecision({ approvalId: "ap-1", decision: "allow-always" }, shown), "never a wider grant");
  assert.ok("error" in petDecision({ approvalId: "ap-2", decision: "allow" }, shown), "only the request shown");
  assert.ok("error" in petDecision({ approvalId: "ap-1", decision: "allow" }, null), "nothing waiting");
  const risky = petApprovalFrom(ask({ riskLevel: "high" }), 0);
  assert.ok("error" in petDecision({ approvalId: "ap-1", decision: "allow" }, risky), "no Allow from the pet for high risk");
  assert.deepEqual(petDecision({ approvalId: "ap-1", decision: "deny" }, risky), { decision: "deny" });
  const q = petApprovalFrom(ask({ category: "user_question" }), 0);
  assert.ok("error" in petDecision({ approvalId: "ap-1", decision: "deny" }, q), "a question is answered in the window");
});
