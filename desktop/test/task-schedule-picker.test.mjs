// Unit tests for ATO-590 (schedule management in the Tasks tab): the pure
// half of renderer/task-schedule-picker.js (picker -> cron, cron -> words,
// the history list) and the wiring read from the sources.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../renderer/task-schedule-picker.js");

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ---------- picker -> cron ---------- */

test("each frequency builds the cron the agent's create form takes", () => {
  assert.equal(P.pickerToCron({ freq: "hourly", hour: 9, minute: 15, days: [], dom: 1 }), "15 * * * *");
  assert.equal(P.pickerToCron({ freq: "daily", hour: 9, minute: 0, days: [], dom: 1 }), "0 9 * * *");
  assert.equal(P.pickerToCron({ freq: "weekdays", hour: 18, minute: 30, days: [], dom: 1 }), "30 18 * * 1-5");
  assert.equal(P.pickerToCron({ freq: "weekly", hour: 7, minute: 45, days: [5, 1], dom: 1 }), "45 7 * * 1,5");
  assert.equal(P.pickerToCron({ freq: "monthly", hour: 9, minute: 0, days: [], dom: 15 }), "0 9 15 * *");
});

test("a weekly pick with no day falls back to Monday, and out-of-range values are clamped", () => {
  assert.equal(P.pickerToCron({ freq: "weekly", hour: 9, minute: 0, days: [], dom: 1 }), "0 9 * * 1");
  assert.equal(P.pickerToCron({ freq: "daily", hour: 99, minute: -4, days: [], dom: 1 }), "0 23 * * *");
  assert.equal(P.pickerToCron({ freq: "monthly", hour: 9, minute: 0, days: [], dom: 40 }), "0 9 31 * *");
});

test("cronToPicker reads back what the picker writes", () => {
  for (const expr of ["15 * * * *", "0 9 * * *", "30 18 * * 1-5", "45 7 * * 1,5", "0 9 15 * *", "0 10 * * 0,6"]) {
    const p = P.cronToPicker(expr);
    assert.ok(p, expr);
    assert.equal(P.pickerToCron(p), expr);
  }
});

test("cronToPicker folds equivalent day lists and refuses what the buttons cannot show", () => {
  assert.equal(P.cronToPicker("0 9 * * 1,2,3,4,5").freq, "weekdays");
  assert.equal(P.cronToPicker("0 9 * * 0,1,2,3,4,5,6").freq, "daily");
  assert.deepEqual(P.cronToPicker("0 9 * * 7").days, [0]);
  for (const expr of ["", "*/5 * * * *", "0 9 * 1 *", "0 9 1 * 1", "0 9-17 * * *", "0 0 9 * * *", "x y z", "60 9 * * *"]) {
    assert.equal(P.cronToPicker(expr), null, expr);
  }
});

/* ---------- button presses ---------- */

test("taskPickerApply writes the cron field, starting from 09:00 daily on an empty form", () => {
  const form = { cronExpression: "" };
  assert.equal(P.taskPickerApply(form, "freq", "weekdays"), "0 9 * * 1-5");
  assert.equal(P.taskPickerApply(form, "hour", "18"), "0 18 * * 1-5");
  assert.equal(P.taskPickerApply(form, "minute", "30"), "30 18 * * 1-5");
  assert.equal(form.cronExpression, "30 18 * * 1-5");
});

test("day toggles make a weekly schedule and never leave a week with no day", () => {
  const form = { cronExpression: "0 9 * * *" };
  assert.equal(P.taskPickerApply(form, "freq", "weekly"), "0 9 * * 1");
  assert.equal(P.taskPickerApply(form, "day", "3"), "0 9 * * 1,3");
  assert.equal(P.taskPickerApply(form, "day", "1"), "0 9 * * 3");
  assert.equal(P.taskPickerApply(form, "day", "3"), "0 9 * * 3");
});

test("the day-of-month stepper stays within 1..31, and unknown keys change nothing", () => {
  const form = { cronExpression: "0 9 1 * *" };
  assert.equal(P.taskPickerApply(form, "dom", "-"), "0 9 1 * *");
  assert.equal(P.taskPickerApply(form, "dom", "+"), "0 9 2 * *");
  assert.equal(P.taskPickerApply(form, "freq", "yearly"), "0 9 2 * *");
  assert.equal(P.taskPickerApply(form, "hour", "24"), "0 9 2 * *");
});

/* ---------- cron -> words ---------- */

test("cronPhrase says the picker's schedules in words", () => {
  assert.equal(P.cronPhrase("0 9 * * 1-5"), "every weekday at 9:00");
  assert.equal(P.cronPhrase("0 9 * * *"), "every day at 9:00");
  assert.equal(P.cronPhrase("5 18 * * *"), "every day at 18:05");
  assert.equal(P.cronPhrase("0 * * * *"), "every hour, on the hour");
  assert.equal(P.cronPhrase("15 * * * *"), "every hour at :15");
  assert.equal(P.cronPhrase("30 8 * * 1"), "every Monday at 8:30");
  assert.equal(P.cronPhrase("0 18 * * 5,1"), "every Monday and Friday at 18:00");
  assert.equal(P.cronPhrase("0 7 * * 1,3,5"), "every Monday, Wednesday and Friday at 7:00");
  assert.equal(P.cronPhrase("0 10 * * 0,6"), "every weekend day at 10:00");
  assert.equal(P.cronPhrase("0 9 1 * *"), "on day 1 of every month at 9:00");
});

test("cronPhrase covers common steps and gives up on the rest", () => {
  assert.equal(P.cronPhrase("* * * * *"), "every minute");
  assert.equal(P.cronPhrase("*/5 * * * *"), "every 5 minutes");
  assert.equal(P.cronPhrase("0 */2 * * *"), "every 2 hours");
  assert.equal(P.cronPhrase("30 */3 * * *"), "every 3 hours at :30");
  assert.equal(P.cronPhrase("0 9 * 1 *"), null);
  assert.equal(P.cronPhrase("0 9-17 * * 1-5"), null);
  assert.equal(P.cronPhrase(""), null);
});

test("schedulePhrase reads a task's schedule as the agent returns it", () => {
  assert.equal(P.schedulePhrase({ kind: "cron", expression: "0 9 * * 1-5" }), "every weekday at 9:00");
  assert.equal(P.schedulePhrase({ kind: "cron", expression: "0 9 * * *", tz: "Europe/Berlin" }), "every day at 9:00 (Europe/Berlin)");
  assert.equal(P.schedulePhrase({ kind: "interval", everyMs: 300_000 }), "every 5 minutes");
  assert.equal(P.schedulePhrase({ kind: "interval", everyMs: 3_600_000 }), "every hour");
  assert.equal(P.schedulePhrase({ kind: "interval", everyMs: 90_000 }), "every 90 seconds");
  assert.equal(P.schedulePhrase({ kind: "at", at: 1 }), null);
  assert.equal(P.schedulePhrase(null), null);
});

/* ---------- the picker's markup ---------- */

test("the picker marks the current choice and shows the phrase; a custom cron says so", () => {
  const html = P.taskPickerHTML({ cronExpression: "30 8 * * 1" });
  assert.match(html, /data-act="tasks:pick:freq:weekly" aria-pressed="true"/);
  assert.match(html, /data-act="tasks:pick:day:1" aria-pressed="true"/);
  assert.match(html, /data-act="tasks:pick:hour:8" aria-pressed="true"/);
  assert.match(html, /data-act="tasks:pick:minute:30" aria-pressed="true"/);
  assert.match(html, /Runs every Monday at 8:30\./);
  const custom = P.taskPickerHTML({ cronExpression: "0 9-17 * * *" });
  assert.match(custom, /A custom schedule/);
  assert.doesNotMatch(custom, /aria-pressed="true"/);
  // A minute the buttons do not offer still shows as chosen.
  assert.match(P.taskPickerHTML({ cronExpression: "7 9 * * *" }), /tasks:pick:minute:7" aria-pressed="true"/);
});

/* ---------- a task's page ---------- */

test("Pause shows on a waiting task, Resume on a paused one, neither on an agent without the routes", () => {
  assert.equal(P.taskPauseAction({ status: "pending" }, { unsupported: false }), "pause");
  assert.equal(P.taskPauseAction({ status: "paused" }, { unsupported: false }), "resume");
  assert.equal(P.taskPauseAction({ status: "running" }, { unsupported: false }), null);
  assert.equal(P.taskPauseAction({ status: "completed" }, { unsupported: false }), null);
  assert.equal(P.taskPauseAction({ status: "pending" }, { unsupported: true }), null);
});

test("the history lists runs with their outcome, and nothing on an agent without the route", () => {
  const fmt = (ms) => "T" + ms;
  const html = P.taskRunsHTML({
    unsupported: false, available: true, loading: false, error: null,
    runs: [
      { id: 2, attempt: 2, startedAt: 2_000, endedAt: 65_000, outcome: "completed", error: null },
      { id: 1, attempt: 1, startedAt: 1_000, endedAt: 1_500, outcome: "retry", error: "boom <x>" },
    ],
  }, fmt);
  assert.match(html, /Past runs/);
  assert.match(html, />done</);
  assert.match(html, />failed, retried</);
  assert.match(html, /T2000/);
  assert.match(html, /1m 03s/);
  assert.match(html, /boom &lt;x&gt;/);
  assert.equal(P.taskRunsHTML({ unsupported: true, runs: [] }, fmt), "");
  assert.match(P.taskRunsHTML({ unsupported: false, available: true, runs: [] }, fmt), /No runs yet/);
  assert.equal(P.runOutcomeLabel(null), "running");
  assert.equal(P.runOutcomeLabel("interrupted"), "stopped");
});

/* ---------- wiring ---------- */

test("the window loads the picker before renderer.js and the main process wires its routes", () => {
  const html = src("../renderer/index.html");
  const picker = html.indexOf('<script src="task-schedule-picker.js"></script>');
  const renderer = html.indexOf('<script src="renderer.js"></script>');
  assert.ok(picker > 0 && renderer > picker, "task-schedule-picker.js loads before renderer.js");
  assert.match(html, /css\/task-schedule-picker\.css/);
  const preload = src("../preload/preload.ts");
  for (const channel of ["agent:pauseTask", "agent:resumeTask", "agent:taskRuns"]) {
    assert.ok(preload.includes(`"${channel}"`), channel);
  }
  assert.match(src("../main/main.ts"), /wireTaskControlsIpc\(\{ client \}\)/);
  const ipc = src("../main/task-controls-ipc.ts");
  assert.match(ipc, /no route/);
  const client = src("../main/agent-client.ts");
  assert.match(client, /\/api\/tasks\/\$\{encodeURIComponent\(id\)\}\/pause/);
  assert.match(client, /\/api\/tasks\/\$\{encodeURIComponent\(id\)\}\/runs/);
});
