// ATO-901: the retry under the user's own message is inert while a turn
// runs, and the toast for a resend that lands mid-turn says so in plain
// words. msgActs runs in a vm context with its neighbours stubbed.
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
function userActs(S) {
  const c = vm.createContext({ S, esc: (s) => String(s), ic: (n) => "<svg data-ic=\"" + n + "\"></svg>", isLastReply: () => false });
  vm.runInContext(constLine("ACTED_RETRY_HINT") + constLine("BUSY_RETRY_HINT") + fn("msgActs") + "globalThis.msgActs = msgActs;", c);
  return c.msgActs({ id: "u1", k: "user", text: "show my files" });
}

test("idle: the user bubble's retry resends", () => {
  const html = userActs({ busy: false, pending: null, streamId: null });
  assert.match(html, /data-resend="u1"/);
  assert.doesNotMatch(html, /msgact-off/);
});

test("while a turn runs or waits for an approval: inert, with the reason", () => {
  for (const S of [{ busy: true, pending: null, streamId: "a9" }, { busy: false, pending: { id: "p" }, streamId: null }]) {
    const html = userActs(S);
    assert.doesNotMatch(html, /data-resend/);
    assert.match(html, /msgact-off/);
    assert.match(html, /data-tip="Wait for the answer to finish"/);
  }
});

test("the mid-turn toast has no dash and says what Enter does", () => {
  const body = fn("resendUser");
  assert.match(body, /toast\('The agent is still answering', 'Your message is in the box: press Enter to add it to this answer, or wait\.'/);
  assert.doesNotMatch(body, /A turn is already running/);
});
