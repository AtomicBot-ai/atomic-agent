// ATO-2514: Create tasks under meeting notes (renderer/meeting-tasks.js).
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const T = require("../renderer/meeting-tasks.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const NOTES = [
  "## Decisions", "", "1. Ship on Friday.", "", "## Action items", "",
  "| # | Task | Owner | Due |", "|---|------|-------|-----|",
  "| 1 | Send the deck to Anna | **Max** | 2026-12-03 |",
  "| 2 | Book the room | \"unassigned\" | not set |",
  "| 3 | Check the budget | Lee | next Friday |", "", "## Open questions", "", "- Who pays?",
].join("\n");

test("the action items come out of the meeting-notes table, unknowns empty", () => {
  assert.deepEqual(T.meetingActionItems(NOTES), [
    { task: "Send the deck to Anna", owner: "Max", due: "2026-12-03" },
    { task: "Book the room", owner: "", due: "" },
    { task: "Check the budget", owner: "Lee", due: "next Friday" },
  ]);
});

test("no table, or a table that says None, gives no items (and so no button)", () => {
  assert.deepEqual(T.meetingActionItems("Just a reply with | pipes | in it."), []);
  assert.deepEqual(T.meetingActionItems("| # | Task | Owner | Due |\n|---|---|---|---|\n| 1 | None. | | |"), []);
  assert.deepEqual(T.meetingActionItems(""), []);
});

test("the Create tasks button shows under meeting notes with a table, and under nothing else", () => {
  globalThis.BR = { taskCreate() {} };
  globalThis.esc = (t) => String(t);
  globalThis.ic = () => "";
  try {
    const reply = (text, more = {}) => ({ k: "assistant", id: "m1", text, ...more });
    assert.match(T.meetingTasksButtonHTML(reply(NOTES)), /data-mtt-open="m1"/);
    assert.equal(T.meetingTasksButtonHTML(reply("Just a plain answer.")), "");
    assert.equal(T.meetingTasksButtonHTML(reply("| # | Task | Owner | Due |\n|---|---|---|---|\n| 1 | None. | | |")), "");
    assert.equal(T.meetingTasksButtonHTML(reply(NOTES, { placeholder: true })), "", "not while it is still streaming");
    assert.equal(T.meetingTasksButtonHTML({ k: "user", id: "u1", text: NOTES }), "");
  } finally {
    delete globalThis.BR;
    delete globalThis.esc;
    delete globalThis.ic;
  }
});

test("the date is the due date when it is one, else the next day", () => {
  assert.equal(T.meetingTaskDay("2026-12-03", 0), "2026-12-03");
  const now = new Date(2026, 10, 30, 15, 0).getTime();
  assert.equal(T.meetingTaskDay("next Friday", now), "2026-12-01");
  assert.equal(T.meetingTaskDay("", now), "2026-12-01");
});

test("the reminder runs at 9:00 local on its day; a bad date is NaN", () => {
  assert.equal(T.meetingTaskAt("2026-12-03"), new Date(2026, 11, 3, 9, 0).getTime());
  assert.ok(Number.isNaN(T.meetingTaskAt("2026-02-31")));
  assert.ok(Number.isNaN(T.meetingTaskAt("tomorrow")));
});

test("the reminder message names the task and owner and asks only for a reminder", () => {
  const m = T.meetingTaskMessage({ task: "Book the room", owner: "Max" });
  assert.match(m, /Book the room \(owner: Max\)/);
  assert.match(m, /Do not do the task yourself/);
  assert.doesNotMatch(T.meetingTaskMessage({ task: "X", owner: "" }), /owner/);
  assert.doesNotMatch(m, /—/);
});

test("wiring: the button sits in the reply's action row and the file loads before renderer.js", () => {
  assert.match(src("../renderer/renderer.js"), /typeof meetingTasksButtonHTML === 'function' \? meetingTasksButtonHTML\(m\) : ''/);
  const html = src("../renderer/index.html");
  const at = html.indexOf('src="meeting-tasks.js"');
  assert.ok(at > 0 && at < html.indexOf('src="renderer.js"'));
  assert.match(src("../renderer/meeting-tasks.js"), /BR\.taskCreate\(\{message: meetingTaskMessage\(it\), kind: 'at', expression: String\(meetingTaskAt\(it\.day\)\)\}\)/);
});
