// ATO-2526: Settings › Logbook, the day timeline and "away" (main/logbook-prefs.ts),
// against the built output, and their wiring.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../out/main/logbook-prefs.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("Save sends only what the runtime takes, and says what is wrong otherwise", () => {
  assert.deepEqual(P.logbookSaveBody({ intervalMinutes: 10, retentionDays: 30, excludeApps: [" Slack ", "slack", ""], titleOnlyApps: ["Mail"], standupAt: "09:00" }), {
    intervalMinutes: 10, retentionDays: 30, excludeApps: ["Slack"], titleOnlyApps: ["Mail"], standupAt: "09:00",
  });
  assert.deepEqual(P.logbookSaveBody({ action: "start" }), { action: "start" });
  assert.deepEqual(P.logbookSaveBody({ standupAt: null }), { standupAt: null }, "null turns the standup off");
  assert.equal(P.logbookSaveBody({ intervalMinutes: 0 }), "A note every 1 to 60 minutes.");
  assert.equal(P.logbookSaveBody({ standupAt: "9am" }), "The standup time looks like 09:00.");
  assert.equal(P.logbookSaveBody({ action: "pause" }), "That is not a logbook action.", "pausing is the chip's");
  assert.equal(P.logbookSaveBody({}), "Nothing to save.");
});

test("a day is today, yesterday or a date; a delete names notes or the whole day", () => {
  assert.equal(P.cleanDay("yesterday"), "yesterday");
  assert.equal(P.cleanDay("2026-11-27"), "2026-11-27");
  assert.equal(P.cleanDay("../etc"), null);
  assert.deepEqual(P.logbookDeleteBody({ day: "2026-11-27", all: true }), { day: "2026-11-27", all: true });
  assert.deepEqual(P.logbookDeleteBody({ day: "2026-11-27", at: ["2026-11-27T10:05:00.000Z", 7] }), { day: "2026-11-27", at: ["2026-11-27T10:05:00.000Z"] });
  assert.equal(P.logbookDeleteBody({ day: "2026-11-27", at: [] }), null, "an empty list deletes nothing, never the day");
  assert.equal(P.logbookDeleteBody({ day: "today", all: true }), null, "the whole day only by its date");
});

test("a day's notes are read, odd rows dropped", () => {
  assert.deepEqual(P.parseLogbookDay({ day: "2026-11-27", entries: [{ at: "t1", app: "Mail", bundleId: "x", text: "Reading mail" }, { at: 5 }] }), {
    day: "2026-11-27", entries: [{ at: "t1", app: "Mail", text: "Reading mail" }],
  });
  assert.equal(P.parseLogbookDay({ entries: [] }), null);
});

test("away while the screen is locked or there was no input for the idle time", () => {
  assert.equal(P.isAway("active", false), false);
  assert.equal(P.isAway("active", true), true);
  assert.equal(P.isAway("idle", false), true);
  assert.equal(P.isAway("locked", false), true);
  assert.equal(P.isAway("unknown", false), false, "an unknown state does not stop the logbook");
  assert.equal(P.AWAY_IDLE_SECONDS, 300);
});

test("wiring: away feeds the mark, the timeline routes, the bridge, Settings and the page", () => {
  const main = src("../main/main.ts");
  assert.match(main, /const logbookAway = watchLogbookAway\(\(\) => void logbook\.beat\(\)\);/);
  assert.match(main, /away: logbookAway/);
  assert.match(main, /openTimeline: \(\) => \{ openWindowAgain\(\); showLogbookTimeline\(win\); \}/);
  assert.match(main, /wireLogbookTimelineIpc\(logbook, \(\) => client\.isRemote\);/);
  const away = src("../main/logbook-away.ts");
  for (const ev of ["lock-screen", "unlock-screen", "suspend", "resume"]) assert.match(away, new RegExp(`powerMonitor\\.on\\("${ev}"`), ev);
  assert.match(away, /getSystemIdleState\(AWAY_IDLE_SECONDS\)/);
  const ipc = src("../main/logbook-timeline-ipc.ts");
  for (const ch of ["refresh", "save", "day", "delete"]) assert.match(ipc, new RegExp(`ipcMain\\.handle\\("logbook:${ch}"`), ch);
  assert.match(ipc, /control\.call\("DELETE", "\/api\/logbook\/entries", body\)/);
  const preload = src("../preload/preload.ts");
  for (const name of ["logbookRefresh", "logbookSave", "logbookDay", "logbookDelete", "onLogbookTimeline"]) assert.match(preload, new RegExp(`\\b${name}:`), name);
  const r = src("../renderer/renderer.js");
  assert.match(r, /\['logbook','Logbook','eye',\['logbook'\]\]/);
  assert.match(r, /else if \(pane === 'logbook'\) logbookTabEntered\(\);/);
  assert.match(r, /if \(p === 'logbook'\) return logbookTab\(\);/);
  assert.match(r, /if \(k === 'logbook'\) \{ close\(\); logbookAct\(a\.slice\(8\)\); return; \}/);
  const html = src("../renderer/index.html");
  for (const f of ["logbook-settings.js", "logbook-timeline.js"]) assert.ok(html.indexOf(`src="${f}"`) > 0 && html.indexOf(`src="${f}"`) < html.indexOf('src="renderer.js"'), f);
});
