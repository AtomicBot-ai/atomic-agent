// ATO-2526: Settings › Logbook (renderer/logbook-settings.js) and the day
// timeline (renderer/logbook-timeline.js): their states, the on/off switch,
// Save, and deleting a note or a whole day after a confirm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const calls = [];
let saveAnswer = { ok: true, view: null };
let dayAnswer = { ok: true, day: "2026-11-27", entries: [] };
const fields = {
  '[data-lbs="interval"]': { value: "10" },
  '[data-lbs="keep"]': { value: "30" },
  '[data-lbs="exclude"]': { value: "Slack\n\n zoom.us " },
  '[data-lbs="titleonly"]': { value: "Mail" },
  '[data-lbs="standup"]': { checked: true },
  '[data-lbs="standupAt"]': { value: "08:30" },
};
const root = { innerHTML: "" };
globalThis.document = {
  querySelector: (sel) => fields[sel] || null,
  getElementById: () => root,
  createElement: () => root,
  body: { appendChild: () => {} },
};
globalThis.BR = {
  logbookRefresh: async () => ({ ok: true, view: null }),
  logbookSave: async (input) => { calls.push(["save", input]); return saveAnswer; },
  logbookDay: async (day) => { calls.push(["day", day]); return dayAnswer; },
  logbookDelete: async (input) => { calls.push(["delete", input]); return { ok: true, removed: input.all ? 2 : 1 }; },
};
globalThis.S = { settings: 0 };
globalThis.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
globalThis.ic = (n) => "<i:" + n + ">";

const L = require("../renderer/logbook-settings.js");
const T = require("../renderer/logbook-timeline.js");
// In the window both are classic scripts and share globals; here the timeline finds Settings' state the same way.
globalThis.LBS = L.LBS;
const tick = () => new Promise((r) => setTimeout(r, 0));

const VIEW = {
  state: "off", supported: true, reason: null, intervalMinutes: 5, retentionDays: 14,
  excludeApps: [], titleOnlyApps: [], standupAt: null, days: ["2020-01-15"], notesToday: 0,
};

test("loading, then no logbook on an old agent, then a refused platform says why", () => {
  L.LBS.view = null; L.LBS.loaded = false;
  assert.match(L.logbookTab(), /Reading the logbook settings/);
  L.LBS.loaded = true;
  assert.match(L.logbookTab(), /This version of the agent has no logbook/);
  L.LBS.view = { ...VIEW, supported: false, reason: "The logbook needs X11 on Linux." };
  assert.match(L.logbookTab(), /The logbook needs X11 on Linux\./);
  assert.doesNotMatch(L.logbookTab(), /data-act="logbook:toggle"/, "no switch where it cannot run");
});

test("the switch starts and stops through the runtime", async () => {
  L.LBS.view = VIEW;
  assert.match(L.logbookTab(), /role="switch" aria-checked="false" data-act="logbook:toggle"[^>]*>Turn on/);
  saveAnswer = { ok: true, view: { ...VIEW, state: "on" } };
  L.logbookAct("toggle");
  await tick();
  assert.deepEqual(calls.at(-1), ["save", { action: "start" }]);
  assert.equal(L.LBS.view.state, "on");
  assert.match(L.logbookTab(), /Turn off/);
});

test("Save reads the fields: one app per line, the standup time only when ticked", async () => {
  L.logbookAct("save");
  await tick();
  assert.deepEqual(calls.at(-1), ["save", {
    intervalMinutes: 10, retentionDays: 30, excludeApps: ["Slack", "zoom.us"], titleOnlyApps: ["Mail"], standupAt: "08:30",
  }]);
  fields['[data-lbs="standup"]'].checked = false;
  assert.equal(L.lbsReadForm(globalThis.document).standupAt, null);
});

test("a refused save says so in plain words, the reason behind Details", async () => {
  saveAnswer = { ok: false, error: "Notes are kept for 1 to 365 days." };
  L.logbookAct("save");
  await tick();
  const html = L.logbookTab();
  assert.match(html, /Could not save the logbook settings\./);
  assert.doesNotMatch(html, /1 to 365/);
  L.logbookAct("details");
  assert.match(L.logbookTab(), /Notes are kept for 1 to 365 days\./);
});

test("the timeline opens on today, shows an empty day, then the notes newest first", async () => {
  T.logbookTimelineOpen();
  await tick();
  assert.deepEqual(calls.at(-1), ["day", "today"]);
  assert.match(T.lbtHTML(), /No notes on this day/);
  assert.match(T.lbtHTML(), /<option value="2020-01-15">/, "older days from the state");
  dayAnswer = { ok: true, day: "2026-11-27", entries: [
    { at: "2026-11-27T09:00:00.000Z", app: "Mail", text: "Reading mail" },
    { at: "2026-11-27T09:05:00.000Z", app: "Code", text: "Editing logbook.ts" },
  ] };
  T.logbookTimelineOpen();
  await tick();
  const html = T.lbtHTML();
  assert.ok(html.indexOf("Editing logbook.ts") < html.indexOf("Reading mail"), "newest first");
  assert.match(html, /2 notes/);
});

const click = (what) => T.lbtClick({ target: { closest: () => ({ getAttribute: () => what }) } });

test("a note is deleted only after its confirm", async () => {
  const before = calls.length;
  click("ask:2026-11-27T09:00:00.000Z");
  assert.match(T.lbtHTML(), /Delete this note\?/);
  assert.equal(calls.length, before, "asking deletes nothing");
  click("del:2026-11-27T09:00:00.000Z");
  await tick();
  assert.deepEqual(calls.at(-1), ["delete", { day: "2026-11-27", at: ["2026-11-27T09:00:00.000Z"] }]);
  assert.doesNotMatch(T.lbtHTML(), /Reading mail/);
  assert.match(T.lbtHTML(), /Note deleted\./);
});

test("the whole day is deleted only after its confirm, which says it cannot be undone", async () => {
  click("askall");
  assert.match(T.lbtHTML(), /Delete all 1 note from .*\? This cannot be undone\./);
  click("delall");
  await tick();
  assert.deepEqual(calls.at(-1), ["delete", { day: "2026-11-27", all: true }]);
  assert.match(T.lbtHTML(), /No notes on this day/);
});
