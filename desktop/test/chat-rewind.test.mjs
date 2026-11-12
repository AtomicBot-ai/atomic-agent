// ATO-1056 / ATO-1058: Roll back here, Edit and Fork from here on a message.
// main/chat-rewind.ts is checked against the built output (npm run build
// first); the pure half of renderer/chat-rewind.js is loaded as a CommonJS
// module; the wiring is read from the sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/chat-rewind.js");
const R = require("../renderer/chat-rewind.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ---------- main: what may be sent, and the answer ---------- */

test("the window may send only a whole non-negative position and a question's text", () => {
  assert.deepEqual(M.rewindRequestBody(2, "fix it"), { priorQuestions: 2, expectText: "fix it" });
  assert.equal(M.rewindRequestBody(-1, "x"), null);
  assert.equal(M.rewindRequestBody(1.5, "x"), null);
  assert.equal(M.rewindRequestBody("1", "x"), null);
  assert.equal(M.rewindRequestBody(0, "  "), null);
  assert.equal(M.rewindRequestBody(0, 7), null);
});

test("the agent's answers read as ok, refusal, unknown chat or an agent without the routes", () => {
  assert.deepEqual(M.rewindAnswer(200, { id: "s-1", files: [] }), { ok: true, supported: true, data: { id: "s-1", files: [] } });
  assert.deepEqual(M.rewindAnswer(409, { error: { message: "busy", code: "turn_in_progress" } }), {
    ok: false, supported: true, code: "turn_in_progress", error: "busy",
  });
  assert.equal(M.rewindAnswer(404, { error: { message: "session not found: s-1", code: "session_not_found" } }).code, "session_not_found");
  assert.equal(M.rewindAnswer(404, { error: { message: "no route" } }).supported, false);
  assert.equal(M.rewindAnswer(500, null).error, "HTTP 500");
});

/* ---------- renderer: which question, and what the confirmation says ---------- */

test("a reply stands for the question it answers; a steer stands for none", () => {
  const q0 = { id: "u0", k: "user", text: "first" };
  const a0 = { id: "a0", k: "assistant", text: "one" };
  const q1 = { id: "u1", k: "user", text: "second" };
  const steer = { id: "u2", k: "user", text: "and this", steered: true };
  const a1 = { id: "a1", k: "assistant", text: "two" };
  const log = [q0, a0, q1, steer, a1];
  assert.equal(R.rewindQuestionFor(log, q1), q1);
  assert.equal(R.rewindQuestionFor(log, a0), q0);
  assert.equal(R.rewindQuestionFor(log, a1), q1);
  assert.equal(R.rewindQuestionFor(log, steer), null);
  assert.equal(R.rewindQuestionFor([a0], a0), null);
  assert.equal(R.rewindQuestionFor(log, { id: "t", k: "tool" }), null);
});

test("the confirmation lists the files that change, the ones that cannot, and what is never undone", () => {
  const s = R.rewindSummary({
    removed: { questions: 2, replies: 1 },
    files: [
      { path: "/w/app/src/a.ts", action: "restore" },
      { path: "/w/app/new.txt", action: "delete" },
      { path: "/elsewhere/b.md", action: "restore" },
    ],
    notRestorable: [{ path: "/w/app/photo.png", reason: "binary" }],
    incomplete: true,
    uncovered: [{ tool: "os.shell.run", count: 2 }, { tool: "os.git.commit", count: 1 }, { tool: "os.fs.write", count: 4 }],
  }, "/w/app/");
  assert.equal(s.removedText, "2 messages of yours and 1 reply will be removed from this chat.");
  assert.deepEqual(s.restore, ["src/a.ts", "/elsewhere/b.md"]);
  assert.deepEqual(s.remove, ["new.txt"]);
  assert.deepEqual(s.cannot, ["photo.png (not a text file)"]);
  assert.match(s.warnings[0], /no longer kept/);
  assert.equal(s.warnings[1], "This part of the chat also ran 2 shell commands, 1 git command. What they changed is not undone.");
  assert.match(s.warnings.at(-1), /Shell commands and Fusion workers are never undone/);
});

test("an empty preview still says what goes and that shell changes stay", () => {
  const s = R.rewindSummary({ removed: { questions: 1, replies: 1 }, files: [], notRestorable: [], uncovered: [] }, "");
  assert.equal(s.removedText, "1 message of yours and 1 reply will be removed from this chat.");
  assert.deepEqual([s.restore, s.remove, s.cannot], [[], [], []]);
  assert.equal(s.warnings.length, 1);
});

test("refusals are worded, unknown ones keep the agent's message", () => {
  assert.match(R.rewindRefusalText({ code: "turn_in_progress" }), /still working/);
  assert.match(R.rewindRefusalText({ code: "point_mismatch" }), /changed on the agent side/);
  assert.equal(R.rewindRefusalText({ error: "disk full" }), "disk full");
});

/* ---------- wiring ---------- */

test("the actions are drawn on messages, routed through act() and the overlay, and reach the agent through main", () => {
  const renderer = src("../renderer/renderer.js");
  assert.match(renderer, /rewindActsHTML\(m\)/);
  assert.match(renderer, /S\.overlay === 'rewind'\) html \+= rewindSheetHTML\(\)/);
  assert.match(renderer, /k === 'rewind'\) \{ rewindAct\(/);
  // The copy/retry probes leave the new buttons out, so their pinned orders hold.
  assert.match(renderer, /filter\(\(b\) => !b\.dataset\.rw\)/);
  assert.match(src("../renderer/index.html"), /<script src="chat-rewind.js"><\/script>\s*\n(?:.*\n)*<script src="renderer.js"><\/script>/);
  const preload = src("../preload/preload.ts");
  for (const ch of ["agent:rewindPreview", "agent:rewind", "agent:forkSession"]) assert.ok(preload.includes(`"${ch}"`), ch);
  const ipc = src("../main/chat-rewind-ipc.ts");
  for (const route of ['"rewind/preview"', '"rewind"', '"fork"']) assert.ok(ipc.includes(route), route);
  assert.match(src("../main/main.ts"), /wireChatRewindIpc\(client\)/);
});
