// Unit tests for renderer/overnight.js (ATO-1113): the Run overnight dialog
// and its runs card. Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const O = createRequire(import.meta.url)("../renderer/overnight.js");
const h = { esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]), ic: () => "" };
const H = 3600000;

test("elapsed time reads as minutes, then hours and minutes", () => {
  assert.equal(O.ovnElapsed(0), "0m");
  assert.equal(O.ovnElapsed(45 * 60000), "45m");
  assert.equal(O.ovnElapsed(2 * H + 5 * 60000), "2h 05m");
  assert.equal(O.ovnElapsed(-5), "0m");
});

test("spend shows only when the agent reports it, against the budget when there is one", () => {
  assert.equal(O.ovnSpendLine(null, 5), "");
  assert.equal(O.ovnSpendLine(undefined, null), "");
  assert.equal(O.ovnSpendLine(1.234, 5), "$1.23 of $5.00");
  assert.equal(O.ovnSpendLine(0, null), "$0.00");
});

test("the budget field: empty and 0 are no cap, a dollar sign is fine, nonsense is NaN", () => {
  assert.equal(O.ovnBudgetValue(""), null);
  assert.equal(O.ovnBudgetValue("0"), null);
  assert.equal(O.ovnBudgetValue(" $5 "), 5);
  assert.ok(Number.isNaN(O.ovnBudgetValue("five")));
  assert.ok(Number.isNaN(O.ovnBudgetValue("-1")));
});

test("local models hide the budget; Telegram counts as paired only with an owner and not turned off", () => {
  assert.equal(O.ovnIsLocal("local"), true);
  assert.equal(O.ovnIsLocal("custom"), true);
  assert.equal(O.ovnIsLocal("cloud"), false);
  assert.equal(O.ovnIsLocal("fusion"), false);
  assert.equal(O.ovnTelegramPaired({ ownerUserId: 42, enabled: true }), true);
  assert.equal(O.ovnTelegramPaired({ ownerUserId: 42 }), true);
  assert.equal(O.ovnTelegramPaired({ ownerUserId: 42, enabled: false }), false);
  assert.equal(O.ovnTelegramPaired({ ownerUserId: null, enabled: true }), false);
  assert.equal(O.ovnTelegramPaired(null), false);
});

test("the window stops a run itself only when the agent did not take the time limit", () => {
  const run = { startedAt: 0, limitMs: 8 * H };
  assert.equal(O.ovnOverTime(run, { status: "running", startedAt: 0 }, 9 * H), true);
  assert.equal(O.ovnOverTime(run, { status: "running", startedAt: 0 }, 7 * H), false);
  assert.equal(O.ovnOverTime(run, { status: "running", startedAt: 0, maxDurationMs: 8 * H }, 9 * H), false);
  assert.equal(O.ovnOverTime(run, { status: "completed", startedAt: 0 }, 9 * H), false);
  // A retry or a requeue resets the task's startedAt; the limit still counts from the window's start.
  assert.equal(O.ovnOverTime(run, { status: "running", startedAt: 7 * H }, 9 * H), true);
});

test("status lines for running and finished runs", () => {
  const run = { startedAt: 0, limitMs: 8 * H, budget: 5, task: { status: "running", startedAt: 0, spentUsd: 1.5 } };
  assert.equal(O.ovnStatusLine(run, 2 * H), "Running · 2h 00m of 8h 00m · $1.50 of $5.00");
  assert.equal(O.ovnStatusLine({ ...run, task: { status: "pending" } }, 0), "Starting…");
  assert.equal(O.ovnStatusLine({ ...run, task: { status: "completed", startedAt: 0, completedAt: 6 * H } }, 9 * H), "Done after 6h 00m");
  assert.equal(O.ovnStatusLine({ ...run, task: { status: "cancelled", startedAt: 0, completedAt: H } }, 9 * H), "Stopped after 1h 00m");
});

test("a run the agent cut short says which limit stopped it", () => {
  const run = { startedAt: 0, limitMs: 8 * H, budget: 5 };
  const line = (stopCause, spentUsd) => O.ovnStatusLine({ ...run, task: { status: "completed", completedAt: 8 * H, stopCause, ...(spentUsd === undefined ? {} : { spentUsd }) } }, 9 * H);
  assert.equal(line("time_ceiling"), "Stopped at the time limit after 8h 00m");
  assert.equal(line("cost_ceiling", 5), "Stopped at the budget after 8h 00m · $5.00 of $5.00");
  assert.equal(line("step_ceiling"), "Stopped at the step limit after 8h 00m");
  assert.equal(line("no_progress"), "Stopped, no progress after 8h 00m");
  assert.equal(line("credit_exhausted"), "Stopped, out of credit after 8h 00m");
  assert.equal(line("something_new"), "Stopped early after 8h 00m");
  assert.equal(line("constructor"), "Stopped early after 8h 00m");
  // An agent that does not send the field, or sends null: the plain finished line.
  assert.equal(line(undefined), "Done after 8h 00m");
  assert.equal(line(null), "Done after 8h 00m");
  // Only a completed run is read this way; the other endings keep their own word.
  assert.equal(O.ovnStatusLine({ ...run, task: { status: "failed", completedAt: H, stopCause: "time_ceiling" } }, 9 * H), "Failed after 1h 00m");
});

test("the dialog: budget hidden for local models, Telegram switch only when paired, defaults filled in", () => {
  const st = { local: false, tgPaired: true, busy: false, error: null,
    form: { message: "", folder: "/Users/me/app", budget: "", hours: String(O.OVN_DEFAULT_HOURS), notify: true } };
  const cloud = O.ovnDialogHTML(st, h);
  assert.match(cloud, /data-ovn-field="budget"/);
  assert.match(cloud, /data-ovn="notify"[^>]*aria-checked="true"/);
  assert.match(cloud, /value="8"/);
  assert.match(cloud, /\/Users\/me\/app/);
  const local = O.ovnDialogHTML({ ...st, local: true, tgPaired: false }, h);
  assert.doesNotMatch(local, /data-ovn-field="budget"/);
  assert.match(local, /cost \$0/);
  assert.doesNotMatch(local, /data-ovn="notify"/);
  assert.match(local, /Pair Telegram/);
});

test("the dialog offers no folder picker for a remote agent", () => {
  const st = { local: false, tgPaired: false, busy: false, error: null, remote: false,
    form: { message: "", folder: "/Users/me/app", budget: "", hours: "8", notify: false } };
  assert.match(O.ovnDialogHTML(st, h), /data-ovn="pick"/);
  const remote = O.ovnDialogHTML({ ...st, remote: true }, h);
  assert.doesNotMatch(remote, /data-ovn="pick"/);
  assert.doesNotMatch(remote, /\/Users\/me\/app/);
  assert.match(remote, /own folder on the other computer/);
});

test("the runs card: Stop while running, Dismiss when finished, nothing when empty", () => {
  assert.equal(O.ovnRunsHTML([], 0, h), "");
  const live = O.ovnRunsHTML([{ id: "t1", title: "fix <tests>", sessionId: "s1", startedAt: 0, limitMs: H, task: { status: "running" } }], 0, h);
  assert.match(live, /data-ovn="stop:t1"/);
  assert.match(live, /data-ovn="chat:t1"/);
  assert.match(live, /fix &lt;tests&gt;/);
  const done = O.ovnRunsHTML([{ id: "t1", title: "x", startedAt: 0, limitMs: H, task: { status: "completed" } }], 0, h);
  assert.match(done, /data-ovn="dismiss:t1"/);
  assert.doesNotMatch(done, /data-ovn="stop:/);
});

test("UI copy has no em dashes, and the composer's + menu opens the dialog", () => {
  const src = readFileSync(new URL("../renderer/overnight.js", import.meta.url), "utf8");
  assert.equal(src.includes("—"), false);
  const att = readFileSync(new URL("../renderer/attachments.js", import.meta.url), "utf8");
  assert.match(att, /data-ovn="open"[^\n]*Run overnight/);
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.match(html, /<div id="overnight"><\/div>/);
  assert.ok(html.indexOf('src="overnight.js"') < html.indexOf('src="renderer.js"'));
});
