// Unit tests for main/quit-question.ts, against the built output.
// Run: npm run build && npm run test:unit
// ATO-1696: a quit asks when a chat is still working, not only when messages
// are queued (ATO-135), in one dialog for both, and says nothing otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { quitQuestion, workingChatCount } = require("../out/main/quit-question.js");

test("nothing queued and nothing working: the quit goes without asking", () => {
  assert.equal(quitQuestion({ queued: 0, working: 0 }), null);
});

test("only queued messages: the ATO-135 question, word for word", () => {
  assert.deepEqual(quitQuestion({ queued: 1, working: 0 }), {
    message: "A queued message has not been sent",
    detail: "They wait for their chat's turn to end. Quitting now drops them.",
  });
  assert.equal(quitQuestion({ queued: 3, working: 0 }).message, "3 queued messages have not been sent");
});

test("a chat still working asks, and says the quit stops its reply", () => {
  const one = quitQuestion({ queued: 0, working: 1 });
  assert.equal(one.message, "A chat is still working");
  assert.match(one.detail, /stops its reply/);
  const two = quitQuestion({ queued: 0, working: 2 });
  assert.equal(two.message, "2 chats are still working");
  assert.match(two.detail, /stops their replies/);
});

test("working chats and queued messages: one question that names both", () => {
  const q = quitQuestion({ queued: 2, working: 1 });
  assert.equal(q.message, "A chat is still working");
  assert.match(q.detail, /2 queued messages are dropped too\./);
  assert.match(quitQuestion({ queued: 1, working: 3 }).detail, /A queued message is dropped too\./);
});

test("nonsense counts are read as none", () => {
  assert.equal(quitQuestion({ queued: Number.NaN, working: -1 }), null);
});

test("turns are counted by chat; a new chat's first turn (no id yet) counts on its own", () => {
  assert.equal(workingChatCount([]), 0);
  assert.equal(workingChatCount([
    { turnId: "a", sessionId: "s1" },
    { turnId: "b", sessionId: "s1" },
    { turnId: "c", sessionId: null },
    { turnId: "d", sessionId: null },
    { turnId: "e", sessionId: "s2" },
  ]), 4);
});

// ATO-2749: a meeting being recorded is named in the quit question.
test("a meeting being recorded asks, and says what is kept", () => {
  assert.equal(quitQuestion({ queued: 0, working: 0, recording: false }), null);
  const q = quitQuestion({ queued: 0, working: 0, recording: true });
  assert.equal(q.message, "A meeting is still being recorded");
  assert.match(q.detail, /^Quitting now stops the recording\. What was recorded so far is kept/);
  const both = quitQuestion({ queued: 1, working: 1, recording: true });
  assert.equal(both.message, "Atomic Agent is still working");
  assert.match(both.detail, /Still running: a chat and a meeting recording\./);
  assert.match(both.detail, /recorded so far is kept/);
  assert.match(both.detail, /A queued message is dropped too\.$/);
  for (const s of [q.message, q.detail, both.detail]) assert.ok(!s.includes("—"), s);
});
