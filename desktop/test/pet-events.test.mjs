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
  const a = petApprovalFrom(ask({ preview: "line one\u0007 two\nline three" }), 0);
  assert.equal(a.text, "line one two");
  assert.equal(petClean("x".repeat(300)).length, 140);
  assert.equal(petApprovalFrom(ask({ reason: "", preview: "first\nsecond" }), 0).text, "first");
  assert.equal(petRiskLine({ riskLevel: "medium", riskReason: "installs a package" }), "Risk check: medium. Installs a package");
  assert.equal(petRiskLine({ riskLevel: "bogus" }), "");
});

test("Allow is offered only for an ordinary request", () => {
  assert.equal(petCanAllow({ category: "shell", preview: "ls" }), true);
  assert.equal(petCanAllow({ category: "shell", preview: "ls", riskLevel: "high" }), false, "a high risk verdict needs the full card");
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

const GENERIC = "no shell guard rule matched; approval required in /Users/me/project";

test("the bubble shows the command, with the gate's reason under it", () => {
  const a = petApprovalFrom(ask({ reason: GENERIC, preview: "rm -rf build\necho done" }), 0);
  assert.equal(a.text, "rm -rf build", "the preview's first line, not the generic reason");
  assert.equal(a.detail, GENERIC);
  assert.equal(a.canAllow, false, "a second line is hidden behind the first: full card");
  assert.equal(petApprovalFrom(ask({ reason: GENERIC, preview: "rm -rf build" }), 0).canAllow, true);
  assert.equal(petApprovalFrom(ask({ reason: "ls -la", preview: "ls -la" }), 0).detail, "", "no second line that repeats the first");
});

test("no preview: the reason is all there is, and Allow waits for the full card", () => {
  const a = petApprovalFrom(ask({ reason: GENERIC, preview: undefined }), 0);
  assert.equal(a.text, GENERIC);
  assert.equal(a.detail, "");
  assert.equal(a.canAllow, false, "never allow what the bubble cannot show");
  assert.equal(petApprovalFrom(ask({ preview: "  \n" }), 0).canAllow, false, "a blank preview shows nothing either");
  assert.ok("error" in petDecision({ approvalId: "ap-1", decision: "allow" }, a));
});

test("a request held after outside content: no Allow, and the note is in the risk line", () => {
  const held = { category: "shell", preview: "ls", riskNote: "held: outside content from evil.example" };
  assert.equal(petCanAllow(held), false);
  assert.equal(petRiskLine(held), "held: outside content from evil.example");
  assert.equal(petRiskLine({ ...held, riskLevel: "medium", riskReason: "reads a file" }), "Risk check: medium. Reads a file held: outside content from evil.example");
  const a = petApprovalFrom({ approvalId: "ap-9", ...held }, 0);
  assert.equal(a.canAllow, false);
  assert.match(a.risk, /evil\.example/);
  assert.ok("error" in petDecision({ approvalId: "ap-9", decision: "allow" }, a));
  assert.equal(petCanAllow({ ...held, riskNote: "   " }), true, "a blank note holds nothing");
});

test("a preview the bubble cannot show whole: no Allow, the full card decides", () => {
  assert.equal(petCanAllow({ category: "shell", preview: "ls\nnpm i evil-pkg" }), false, "a second command hides behind the first line");
  assert.equal(petCanAllow({ category: "shell", preview: "ls\r\nnpm i evil-pkg" }), false, "CRLF counts as a new line");
  assert.equal(petCanAllow({ category: "shell", preview: "ls\n\n" }), true, "trailing blank lines hide nothing");
  const long = "echo " + "a".repeat(140) + "; rm -rf ~";
  assert.equal(petCanAllow({ category: "shell", preview: long }), false, "a clipped line hides its tail");
  assert.equal(petCanAllow({ category: "shell", preview: "a".repeat(140) }), true, "a line that fits is shown whole");
  const a = petApprovalFrom(ask({ preview: "ls\nnpm i evil-pkg" }), 0);
  assert.equal(a.canAllow, false);
  assert.ok("error" in petDecision({ approvalId: "ap-1", decision: "allow" }, a));
});
