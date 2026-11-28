// ATO-2112: Roll back here offers "Chat and files", "Chat only" and "Files only",
// like Claude Code's /rewind. main/chat-rewind.ts is checked against the built
// output (npm run build first); renderer/chat-rewind.js loads as CommonJS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/chat-rewind.js");
const R = require("../renderer/chat-rewind.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const FILES_PREVIEW = {
  removed: { questions: 1, replies: 1 },
  files: [{ path: "/w/src/a.ts", action: "restore" }, { path: "/w/new.txt", action: "delete" }],
  notRestorable: [],
  uncovered: [],
  filesOnly: true,
};

/** The renderer globals chat-rewind.js reads at call time, recording what reaches the agent and the window. */
function fakeWindow(calls, draft = "") {
  const g = globalThis;
  g.S = { overlay: "rewind", agentSession: "s-1", draft, log: [] };
  g.BR = {
    rewind: async (...args) => {
      calls.push(["rewind", ...args]);
      return { ok: true, supported: true, data: { text: "old text", restored: ["/w/src/a.ts"], deleted: ["/w/new.txt"], failed: [] } };
    },
  };
  g.openSession = async (sid) => { calls.push(["open", sid]); };
  g.submit = () => { calls.push(["submit", g.S.draft]); };
  g.document = { getElementById: () => null };
  g.$ = (sel) => (sel === "#entry" ? { value: draft, focus: () => {} } : null);
  g.render = () => {};
  g.toast = (title, text) => { calls.push(["toast", title, text]); };
  g.refreshSend = () => {};
  g.autosize = () => {};
  g.attToEditor = (t) => t;
  g.esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  g.ic = () => "";
  g.sheet = (title, body, foot) => `<h>${title}</h><b>${body}</b><f>${foot}</f>`;
  g.WORKSPACE = "/w";
}

function startBack(preview) {
  Object.assign(R.REWIND, { mode: "back", id: "u1", sid: "s-1", prior: 1, text: "old text", preview, loading: false, busy: false, error: null, draft: "old text" });
}

const footActs = (html) => [...html.split("<f>")[1].matchAll(/data-act="(rewind:[^"]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);

test("Roll back with changed files offers files only, chat only, and chat and files as the default", () => {
  fakeWindow([]);
  startBack(FILES_PREVIEW);
  const html = R.rewindSheetHTML();
  assert.deepEqual(footActs(html), [
    ["rewind:go-files", "Files only"],
    ["rewind:go-chat", "Chat only"],
    ["rewind:go", "Chat and files"],
  ]);
  // The default stays the last, primary button.
  assert.match(html, /class="btn btn-df sm" data-act="rewind:go"/);
  assert.match(html, /Chat only keeps the files as they are now\. Files only keeps the whole chat\./);
  assert.match(html, /Put back as they were/);
});

test("Chat and files sends no flags, as before", async () => {
  const calls = [];
  fakeWindow(calls);
  startBack(FILES_PREVIEW);
  await R.rewindAct("go");
  assert.deepEqual(calls.slice(0, 2), [["rewind", "s-1", 1, "old text", undefined], ["open", "s-1"]]);
});

test("Chat only sends files: false and returns the question to the composer", async () => {
  const calls = [];
  fakeWindow(calls);
  startBack(FILES_PREVIEW);
  await R.rewindAct("go-chat");
  assert.deepEqual(calls.slice(0, 2), [["rewind", "s-1", 1, "old text", false], ["open", "s-1"]]);
  assert.equal(globalThis.S.draft, "old text");
});

test("Files only sends conversation: false, keeps the chat open as it is and leaves the composer alone", async () => {
  const calls = [];
  // A draft in the composer does not block it: the chat is not cut.
  fakeWindow(calls, "half-typed");
  startBack(FILES_PREVIEW);
  await R.rewindAct("go-files");
  assert.deepEqual(calls, [
    ["rewind", "s-1", 1, "old text", true, false],
    ["toast", "Files put back", "2 files put back. "],
  ]);
  assert.equal(globalThis.S.overlay, null);
  assert.equal(globalThis.S.draft, "half-typed");
});

test("Files only is not an Edit action", async () => {
  const calls = [];
  fakeWindow(calls);
  startBack(FILES_PREVIEW);
  R.REWIND.mode = "edit";
  assert.ok(!footActs(R.rewindSheetHTML()).some(([a]) => a === "rewind:go-files"));
  await R.rewindAct("go-files");
  assert.deepEqual(calls, []);
});

test("an agent that does not say filesOnly gets no Files only button, and the action does nothing", async () => {
  const calls = [];
  fakeWindow(calls);
  startBack({ ...FILES_PREVIEW, filesOnly: undefined });
  const html = R.rewindSheetHTML();
  assert.deepEqual(footActs(html), [["rewind:go-chat", "Chat only"], ["rewind:go", "Chat and files"]]);
  assert.doesNotMatch(html, /Files only keeps/);
  await R.rewindAct("go-files");
  assert.deepEqual(calls, []);
});

test("main passes conversation: false on to the agent for a rollback only", () => {
  assert.deepEqual(M.rewindRequestBody(0, "x", true, false), { priorQuestions: 0, expectText: "x", files: true, conversation: false });
  assert.deepEqual(M.rewindRequestBody(0, "x", undefined, "no"), { priorQuestions: 0, expectText: "x" });
  assert.match(src("../main/chat-rewind-ipc.ts"), /rollback \? conversation : undefined/);
  assert.match(src("../preload/preload.ts"), /files\?: boolean, conversation\?: boolean\) =>/);
});

/* ---------- ATO-2752: the spinner on Files only, plain errors with Details ---------- */

const spinning = (html) => [...html.split("<f>")[1].matchAll(/<button[^>]*>(<span class="tk-spin"><\/span>)?([^<]*)</g)]
  .filter((m) => m[1]).map((m) => m[2]);

test("Files only spins on its own button while it runs, like the other two", async () => {
  const calls = [];
  fakeWindow(calls);
  startBack(FILES_PREVIEW);
  const running = R.rewindAct("go-files");
  assert.deepEqual(spinning(R.rewindSheetHTML()), ["Files only"]);
  await running;
  assert.equal(R.REWIND.busyAct, null);
});

test("a thrown IPC error is one plain sentence, the raw reason only behind Details", async () => {
  const calls = [];
  fakeWindow(calls);
  globalThis.BR.rewind = async () => { throw new Error("Error invoking remote method 'agent:rewind': Error: disk is read-only"); };
  startBack(FILES_PREVIEW);
  await R.rewindAct("go");
  const body = R.rewindSheetHTML().split("<b>")[1];
  assert.match(body, /Something went wrong on the agent’s side\. Try again\.<details class="rw-det"><summary>Details<\/summary><code>disk is read-only<\/code><\/details>/);
  assert.doesNotMatch(body, /Error invoking remote method/);
  // A refusal the agent names keeps its own sentence and has nothing to fold away.
  globalThis.BR.rewind = async () => ({ ok: false, supported: true, code: "turn_in_progress", error: "busy" });
  await R.rewindAct("go");
  const again = R.rewindSheetHTML().split("<b>")[1];
  assert.match(again, /still working in this chat/);
  assert.doesNotMatch(again, /rw-det/);
});

test("Roll back and Edit use one set of short names", () => {
  fakeWindow([]);
  startBack(FILES_PREVIEW);
  const back = footActs(R.rewindSheetHTML()).map(([, l]) => l);
  R.REWIND.mode = "edit";
  const edit = footActs(R.rewindSheetHTML()).map(([, l]) => l);
  assert.deepEqual(edit, back.filter((l) => l !== "Files only"));
  for (const l of back.concat(edit)) assert.ok(l.length <= 16, l);
  assert.match(src("../renderer/css/overlays.css"), /\.sheet-rewind \.sheetfoot \.btn\{white-space:nowrap\}/);
});
