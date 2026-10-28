// ATO-861: the last reply of a turn that ran no tool offers "Ask again",
// which resends the turn's question. acted-retry-hint.test.mjs stubs the
// turn walk; this one runs the real replyRetryAsk / replyTurnActed over
// drawn transcripts.
//
// renderer.js is read as text; msgActs runs in a vm context with its
// neighbours stubbed. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");

function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

function constLine(name) {
  const at = source.indexOf("\nconst " + name + " = ");
  assert.ok(at >= 0, name + " is a top-level const in renderer.js");
  return source.slice(at + 1, source.indexOf("\n", at + 1) + 1);
}

function actsFor(log, m, busy = false) {
  const c = vm.createContext({
    S: { log, busy, pending: null, streamId: null },
    esc: (s) => String(s),
    ic: (n) => "<i>" + n + "</i>",
  });
  vm.runInContext(
    constLine("ACTED_RETRY_HINT") + constLine("BUSY_RETRY_HINT")
      + ["isLastReply", "replyRetryAsk", "replyTurnActed", "msgActs"].map(fn).join("")
      + "globalThis.msgActs = msgActs;",
    c,
  );
  return c.msgActs(m);
}

const again = (html) => (/data-resend="([^"]+)"[^>]*title="Ask again"/.exec(html) || [])[1] || null;

test("a plain answer can be asked again, through its question, before Copy", () => {
  const log = [{ id: "q1", k: "user", text: "Hi" }, { id: "a1", k: "assistant", text: "Hello" }];
  const html = actsFor(log, log[1]);
  assert.equal(again(html), "q1");
  assert.ok(html.indexOf("Ask again") < html.indexOf("Copy message"));
});

test("a turn that ran a tool or asked for approval has no Ask again, live or reopened", () => {
  for (const mid of [{ id: "t", k: "tool", name: "os.fs.list_dir" }, { id: "p", k: "approval", stored: true }]) {
    const log = [{ id: "q1", k: "user", text: "List my files" }, mid, { id: "a1", k: "assistant", text: "Here they are" }];
    const html = actsFor(log, log[2]);
    assert.equal(again(html), null, mid.k);
    assert.match(html, /msgact-off/, mid.k);
  }
});

test("a tool in an earlier turn does not take the retry from a later plain one", () => {
  const log = [{ id: "q1", k: "user", text: "List my files" }, { id: "t", k: "tool" }, { id: "a1", k: "assistant", text: "Done" },
    { id: "q2", k: "user", text: "Thanks" }, { id: "a2", k: "assistant", text: "Any time" }];
  assert.equal(again(actsFor(log, log[4])), "q2");
});

test("a steer belongs to the turn: Ask again resends the question before it", () => {
  const log = [{ id: "q1", k: "user", text: "Hi" }, { id: "s", k: "user", text: "shorter", steered: true }, { id: "a1", k: "assistant", text: "Hey" }];
  assert.equal(again(actsFor(log, log[2])), "q1");
});

test("only the last reply, and never while a turn runs", () => {
  const log = [{ id: "q1", k: "user", text: "Hi" }, { id: "a1", k: "assistant", text: "Hello" },
    { id: "q2", k: "user", text: "And you?" }, { id: "a2", k: "assistant", text: "Fine" }];
  assert.equal(again(actsFor(log, log[1])), null);
  assert.equal(again(actsFor(log, log[3])), "q2");
  assert.equal(again(actsFor(log, log[3], true)), null);
});

test("a later turn that ended without a reply does not re-ask the older question", () => {
  const log = [{ id: "q1", k: "user", text: "Hi" }, { id: "a1", k: "assistant", text: "Hello" },
    { id: "q2", k: "user", text: "And you?" }, { id: "x", k: "assistant", text: "(no reply)", placeholder: true }];
  assert.equal(again(actsFor(log, log[1])), null);
  assert.equal(again(actsFor(log, log[3])), null);
});

test("an empty question offers nothing to resend", () => {
  const log = [{ id: "q1", k: "user", text: "  " }, { id: "a1", k: "assistant", text: "Hello" }];
  assert.equal(again(actsFor(log, log[1])), null);
});
