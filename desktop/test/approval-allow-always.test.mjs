// ATO-1142: "Always allow" on the approval card. The agent saves an allow
// rule for a request whose approval_request frame says `canAlways: true`; the
// button's words come from `alwaysLabel`. A 400 (no rule saved) resolves
// nothing, so the card opens again for Allow once or Deny.
//
// renderer.js is read as text; the functions under test run in a vm
// context. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const catalog = readFileSync(new URL("../main/analytics/catalog.ts", import.meta.url), "utf8");
const client = readFileSync(new URL("../main/agent-client.ts", import.meta.url), "utf8");
const analytics = readFileSync(new URL("../renderer/analytics.js", import.meta.url), "utf8");

function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  const eol = source.indexOf("\n", at + 1);
  const head = source.slice(at + 1, eol);
  if (head.trimEnd().endsWith("}")) return head + "\n";   // a one-line function
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

function constLine(name) {
  const at = source.indexOf("\nconst " + name + " = ");
  assert.ok(at >= 0, name + " is a top-level const in renderer.js");
  return source.slice(at + 1, source.indexOf("\n", at + 1) + 1);
}

function context({ onScreen = true } = {}) {
  const notes = [];
  const c = vm.createContext({
    S: { log: [], pending: null, busy: true, agentSession: "s1" },
    PENDING_APPROVALS: new Map(),
    APPROVAL_CARDS: new Map(),
    LOGS: [],
    nid: () => "n" + notes.length,
    placeAfterRow: (req, row) => notes.push(row),
    approvalOnScreen: () => onScreen,
  });
  vm.runInContext(constLine("esc").replace(/^const /, "var "), c);
  for (const name of ["approvalNotWaiting", "apprAlwaysOk", "apprAlwaysButton", "apprAlwaysTitle",
    "apprAlwaysRefused", "apprAlwaysReopen", "apprAlwaysSavedNote"]) vm.runInContext(fn(name), c);
  return { c, notes };
}

const gitReq = { approvalId: "a1", sessionId: "s1", cat: "shell", tool: "os.shell.run", preview: "git status",
  canAlways: true, alwaysLabel: 'Always allow "git status" in this project' };

test("the button is drawn only for a request the agent says it can remember", () => {
  const { c } = context();
  assert.equal(c.apprAlwaysOk(gitReq), true);
  assert.equal(c.apprAlwaysOk({ ...gitReq, canAlways: false }), false);
  assert.equal(c.apprAlwaysOk({ ...gitReq, canAlways: undefined }), false, "an older agent sends no canAlways");
  assert.equal(c.apprAlwaysOk({ ...gitReq, canAlways: "true" }), false, "only a real true");
  assert.equal(c.apprAlwaysOk({ ...gitReq, alwaysRefused: true }), false, "not again after a refusal");
});

test("the button reads the agent's label, else Always allow", () => {
  const { c } = context();
  assert.equal(c.apprAlwaysButton(gitReq), 'Always allow "git status" in this project');
  assert.equal(c.apprAlwaysButton({ ...gitReq, alwaysLabel: "" }), "Always allow");
  assert.equal(c.apprAlwaysButton({ ...gitReq, alwaysLabel: undefined }), "Always allow");
  assert.equal(c.apprAlwaysButton({ ...gitReq, alwaysLabel: "x".repeat(80) }), "Always allow", "a long label stays the tooltip");
  assert.match(c.apprAlwaysTitle({ ...gitReq, alwaysLabel: "x".repeat(80) }), /^x{80}\. Saved as a rule/);
});

test("the card draws the button with the w answer and escapes the label", () => {
  const at = source.indexOf("apprAlwaysOk(m) ? '<button");
  assert.ok(at >= 0, "apprCard draws the Always allow button");
  const line = source.slice(at, source.indexOf("\n", at));
  assert.match(line, /data-appr="w"/);
  assert.match(line, /esc\(apprAlwaysButton\(m\)\)/);
  assert.match(line, /esc\(apprAlwaysTitle\(m\)\)/);
});

test("a 400 is a refusal; a taken rule, a not-pending answer and a failed send are not", () => {
  const { c } = context();
  assert.equal(c.apprAlwaysRefused({ ok: true, data: { error: { message: "cannot grant always for this request" } } }), true);
  assert.equal(c.apprAlwaysRefused({ ok: true, data: { resolved: true, grant: "always", rule: { id: "r_1" } } }), false);
  assert.equal(c.apprAlwaysRefused({ ok: true, data: { error: { message: "approvalId not pending: a1" } } }), false);
  assert.equal(c.apprAlwaysRefused({ ok: false, error: "agent gone" }), false);
});

test("a refused rule opens the card again for Allow once or Deny", () => {
  const { c, notes } = context();
  const req = { ...gitReq, state: "approved", at: "10:00:00", landed: false };
  c.S.log.push(req);
  c.apprAlwaysReopen(req, { ok: true, data: { error: { message: "no rules store" } } });
  assert.equal(req.state, undefined);
  assert.equal(req.alwaysRefused, true);
  assert.equal(c.S.pending, req, "the keys answer it again");
  assert.equal(c.S.busy, false, "waiting for the person is not busy");
  assert.equal(c.PENDING_APPROVALS.get("s1"), "a1");
  assert.equal(c.APPROVAL_CARDS.get("s1"), req);
  assert.equal(c.apprAlwaysOk(req), false, "the button is gone");
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /Choose Allow once or Deny\.$/);
  assert.ok(!/ — /.test(notes[0].text));
});

test("a card of a chat not on screen is reopened for its chat, not for this view's keys", () => {
  const { c } = context({ onScreen: false });
  const req = { ...gitReq, sessionId: "s2", state: "approved" };
  c.S.log.push(req);
  c.apprAlwaysReopen(req, { ok: true, data: { error: "no" } });
  assert.equal(c.S.pending, null);
  assert.equal(c.S.busy, true, "another chat's card leaves this chat's busy look alone");
  assert.equal(c.PENDING_APPROVALS.get("s2"), "a1");
});

test("the saved rule's receipt names it, escaped", () => {
  const { c } = context();
  assert.match(c.apprAlwaysSavedNote(gitReq, { resolved: true }).text,
    /^Rule saved: Always allow &quot;git status&quot; in this project\. .*Settings, Privacy\.$/);
  const bare = c.apprAlwaysSavedNote({ ...gitReq, alwaysLabel: "" }, { rule: { commandPrefix: ["git", "<b>"] } }).text;
  assert.match(bare, /Always allow <code>git &lt;b&gt;<\/code>/);
});

test("main forwards allow-always, and analytics counts it as its own choice", () => {
  assert.match(client, /APPROVAL_DECISIONS: readonly ApprovalDecision\[\] = \["allow-once", "allow-in-chat", "allow-always", "deny"\]/);
  assert.match(catalog, /choice: en\(\["allow_once", "allow_in_chat", "allow_always",/);
  assert.match(analytics, /key === 'w' \? 'allow_always'/);
});

test("answerLive sends allow-always only for a card that offers it", () => {
  const body = fn("answerLive");
  assert.match(body, /const always = key === 'w' && apprAlwaysOk\(req\);/);
  assert.match(body, /always \? 'allow-always' : inChat \? 'allow-in-chat'/);
  assert.match(body, /if \(always && apprAlwaysRefused\(res\)\) \{ apprAlwaysReopen\(req, res\);/);
});
