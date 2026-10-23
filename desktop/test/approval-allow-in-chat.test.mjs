// ATO-473 / ATO-461: "Allow in this chat" on the approval card. The agent
// grants the request's command shape (the binary, `git`) for the rest of the
// chat. The card draws the button only for a command the agent names and only
// on an agent that lists `allow-in-chat` on /api/capabilities; an answer the
// agent does not take (a 400) still allows this one call, as allow-once.
//
// renderer.js is read as text; the functions under test run in a vm
// context. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const catalog = readFileSync(new URL("../main/analytics/catalog.ts", import.meta.url), "utf8");
const mainTs = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");

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

function context({ decisions, replies = [] } = {}) {
  const sent = [];
  const notes = [];
  const c = vm.createContext({
    LIVE_CAPS: decisions === undefined ? null : { agent: { approvalDecisions: decisions } },
    BR: {
      approve: (id, decision) => {
        sent.push(decision);
        return Promise.resolve(replies.shift());
      },
    },
    nid: () => "n" + notes.length,
    placeAfterRow: (req, row) => notes.push(row.text),
  });
  vm.runInContext(constLine("esc").replace(/^const /, "var "), c);
  for (const name of ["apprChatOk", "approvalNotWaiting", "apprChatFallback", "apprChatGrantedNote"]) vm.runInContext(fn(name), c);
  return { c, sent, notes };
}

const gitReq = { approvalId: "a1", cat: "shell", tool: "os.shell.run", shape: "git", preview: "git status" };

test("the button is offered for a named command on an agent that lists allow-in-chat", () => {
  const { c } = context({ decisions: ["allow-once", "allow-in-chat", "deny"] });
  assert.equal(c.apprChatOk(gitReq), true);
});

test("no button for bash -c (no shape), for a non-shell request, or on an older agent", () => {
  const on = context({ decisions: ["allow-once", "allow-in-chat", "deny"] }).c;
  assert.equal(on.apprChatOk({ ...gitReq, shape: "" }), false, "the agent names no shape for bash -c");
  assert.equal(on.apprChatOk({ ...gitReq, cat: "fs_write_workspace", tool: "os.fs.write" }), false);
  assert.equal(context({ decisions: undefined }).c.apprChatOk(gitReq), false, "no capabilities read yet");
  assert.equal(context({ decisions: ["allow-once", "deny"] }).c.apprChatOk(gitReq), false, "an agent without the decision");
});

test("a taken allow-in-chat is marked so the card can say what was granted", async () => {
  const { c, sent } = context();
  const res = await c.apprChatFallback(gitReq, "allow-in-chat", { ok: true, data: { resolved: true, grant: "chat" } });
  assert.equal(res.chatGranted, true);
  assert.deepEqual(sent, [], "nothing is sent twice");
});

test("the receipt names the command, escaped: a system row's text is html", () => {
  const { c } = context();
  assert.match(c.apprChatGrantedNote(gitReq).text, /about <code>git<\/code> commands until you start a new chat/);
  const evil = c.apprChatGrantedNote({ ...gitReq, shape: "<img src=x onerror=alert(1)>" }).text;
  assert.ok(!evil.includes("<img"), "the shape is not drawn as markup");
  assert.match(evil, /&lt;img/);
});

test("a 400 to allow-in-chat goes again as allow-once and says the chat part did not happen", async () => {
  const { c, sent, notes } = context({ replies: [{ ok: true, data: { resolved: true, approved: true } }] });
  const res = await c.apprChatFallback(gitReq, "allow-in-chat",
    { ok: true, data: { error: { message: "decision must be one of allow-once|deny|approve|reject" } } });
  assert.deepEqual(sent, ["allow-once"]);
  assert.equal(res.data.resolved, true);
  assert.equal(res.chatGranted, undefined);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^Allowed once\. This agent can.t remember it for the chat/);
});

test("a request no longer pending is not answered again", async () => {
  const { c, sent } = context();
  await c.apprChatFallback(gitReq, "allow-in-chat",
    { ok: true, data: { error: { message: "approvalId not pending: a1" } } });
  assert.deepEqual(sent, []);
});

test("allow-once and deny pass through untouched", async () => {
  const { c, sent } = context();
  const r = { ok: true, data: { error: { message: "boom" } } };
  assert.equal(await c.apprChatFallback(gitReq, "allow-once", r), r);
  assert.equal(await c.apprChatFallback(gitReq, "deny", r), r);
  assert.deepEqual(sent, []);
});

test("main forwards allow-in-chat, and analytics counts it as its own choice", () => {
  assert.match(mainTs, /APPROVAL_DECISIONS\.find\(\(d\) => d === decision\)/);
  assert.match(catalog, /choice: en\(\["allow_once", "allow_in_chat",/);
});
