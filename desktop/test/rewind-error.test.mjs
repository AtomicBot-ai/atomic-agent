// ATO-2752: a failed roll back, edit, fork or answer switch in plain words
// (renderer/rewind-error.js), used by chat-rewind.js and answer-versions.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const E = require("../renderer/rewind-error.js");
const AV = require("../renderer/answer-versions.js");
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const h = { esc: (s) => String(s).replace(/</g, "&lt;"), ic: () => "<svg></svg>" };

test("Electron's wrapper and the Error: prefixes are cut from the raw reason", () => {
  assert.equal(E.rewindRawReason({ error: "Error: Error invoking remote method 'agent:rewind': Error: boom" }), "boom");
  assert.equal(E.rewindRawReason(new Error("Error invoking remote method 'agent:fork': TypeError: x is null")), "x is null");
  assert.equal(E.rewindRawReason({ error: "disk full" }), "disk full");
  assert.equal(E.rewindRawReason(null), "");
});

test("a known code keeps its sentence; anything else is one plain line with the raw reason for Details", () => {
  const code = (r) => (r && r.code === "busy" ? "Still busy." : null);
  assert.deepEqual(E.rewindErrorView({ code: "busy", error: "x" }, code), { text: "Still busy.", detail: "" });
  assert.deepEqual(E.rewindErrorView({ error: "Error invoking remote method 'a': Error: boom" }, code), { text: E.REWIND_ERROR_LINE, detail: "boom" });
  assert.ok(!E.REWIND_ERROR_LINE.includes("—"));
});

test("the notice folds the raw reason under Details and escapes it", () => {
  const html = E.rewindErrorHTML({ text: "Plain.", detail: "<b>raw</b>" }, h);
  assert.match(html, /<span class="grow">Plain\.<details class="rw-det"><summary>Details<\/summary><code>&lt;b>raw&lt;\/b><\/code><\/details><\/span>/);
  assert.doesNotMatch(E.rewindErrorHTML({ text: "Plain.", detail: "" }, h), /details/);
  assert.equal(E.rewindErrorHTML(null, h), "");
});

test("answer switching: plain wording for a gone answer, no raw reason in the toast", () => {
  assert.equal(AV.answerVersionsRefusalText({ code: "no_previous_reply" }), "That earlier answer is gone, so the chat was reloaded.");
  assert.doesNotMatch(AV.answerVersionsRefusalText({ code: "bad_index" }), /drawn again|no longer kept/);
  assert.equal(AV.answerVersionsRefusalText({ error: "Error invoking remote method 'agent:restorePreviousReply': Error: ECONNRESET" }), E.REWIND_ERROR_LINE);
});

test("index.html loads rewind-error.js before both of its users", () => {
  const html = read("../renderer/index.html");
  const at = html.indexOf('<script src="rewind-error.js">');
  assert.ok(at > 0 && at < html.indexOf('<script src="chat-rewind.js">') && at < html.indexOf('<script src="answer-versions.js">'));
});
