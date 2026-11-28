// ATO-2534: the logbook's visible mark (main/logbook-mark.ts), against the
// built output: main says "on screen" only while the chip is in a visible
// window or the menu bar icon is up, and says "not any more" once.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/logbook-mark.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const VIEW = {
  state: "on",
  settings: { enabled: true, intervalMinutes: 5, pausedUntil: null },
  last: { lastOutcome: "skipped", lastReason: "A password manager was in front." },
  notesToday: 3,
  platform: { supported: true, reason: null },
};

test("reads GET /api/logbook and refuses anything else", () => {
  assert.deepEqual(M.parseLogbookView(VIEW), {
    state: "on", pausedUntil: null, intervalMinutes: 5, notesToday: 3,
    lastOutcome: "skipped", lastReason: "A password manager was in front.", supported: true, reason: null,
    retentionDays: 14, excludeApps: [], titleOnlyApps: [], standupAt: null, days: [],
  });
  assert.equal(M.parseLogbookView({ state: "recording" }), null);
  assert.equal(M.parseLogbookView(null), null);
});

test("the mark counts while the menu bar icon is up, or the chip was reported on screen lately", () => {
  const now = 100_000;
  assert.equal(M.markVisible({ chipVisible: false, chipReportedAt: 0, trayShown: true, now }), true);
  assert.equal(M.markVisible({ chipVisible: true, chipReportedAt: now - 1_000, trayShown: false, now }), true);
  assert.equal(M.markVisible({ chipVisible: false, chipReportedAt: now, trayShown: false, now }), false, "a hidden window");
  assert.equal(M.markVisible({ chipVisible: true, chipReportedAt: now - M.CHIP_REPORT_FRESH_MS - 1, trayShown: false, now }), false,
    "a window that stopped reporting (crashed, frozen) no longer counts");
});

test("the runtime is told on screen only while the mark is visible and the logbook is on, and told once when it goes", async () => {
  const posted = [];
  const r = M.createMarkReporter(async (body) => { posted.push(body); });
  assert.equal(await r.beat({ state: "on", visible: false, away: false }), null, "never shown: nothing to say");
  await r.beat({ state: "on", visible: true, away: false });
  await r.beat({ state: "on", visible: true, away: true });
  await r.beat({ state: "on", visible: false, away: false });
  await r.beat({ state: "on", visible: false, away: false });
  await r.beat({ state: "off", visible: true, away: false });
  assert.deepEqual(posted, [{ visible: true, away: false }, { visible: true, away: true }, { visible: false }]);
});

test("a failed 'not on screen' is sent again on the next beat", async () => {
  let fail = true;
  const posted = [];
  const r = M.createMarkReporter(async (body) => { posted.push(body); if (!body.visible && fail) throw new Error("down"); });
  await r.beat({ state: "on", visible: true, away: false });
  await r.beat({ state: "on", visible: false, away: false });
  fail = false;
  await r.beat({ state: "on", visible: false, away: false });
  await r.beat({ state: "on", visible: false, away: false });
  assert.deepEqual(posted, [{ visible: true, away: false }, { visible: false }, { visible: false }]);
});

test("clicks become the runtime's actions, and a pause stays within a day", () => {
  assert.deepEqual(M.logbookActionBody("pause", 30), { action: "pause", minutes: 30 });
  assert.deepEqual(M.logbookActionBody("stop"), { action: "stop" });
  assert.equal(M.logbookActionBody("pause", 5000), null);
  assert.equal(M.logbookActionBody("start"), null, "starting is Settings' or the CLI's, not the chip's");
});

test("errors are plain words, the runtime's own sentence for a refused action", () => {
  assert.equal(M.logbookErrorText(409, { error: { message: "The logbook is already off." } }), "The logbook is already off.");
  assert.match(M.logbookErrorText(404, null), /Update Atomic Agent/);
  assert.match(M.logbookErrorText(0, null), /did not answer/);
});

test("the menu bar menu offers Pause while on and Resume while paused, Stop always", () => {
  const on = M.parseLogbookView(VIEW);
  const labels = (v, o) => M.logbookTrayItems(v, o).filter((i) => i.label).map((i) => i.label);
  assert.deepEqual(labels(on), ["Logbook is on: a note every 5 min, 3 notes today", "Pause for 30 minutes", "Pause for 1 hour", "Stop the logbook", "Open Atomic Agent"]);
  const paused = { ...on, state: "paused", pausedUntil: new Date(2026, 10, 28, 14, 30).getTime() };
  assert.deepEqual(labels(paused, { timeline: true }), ["Logbook paused until 14:30", "Resume", "Stop the logbook", "Open the timeline", "Open Atomic Agent"]);
});

test("wiring: main keeps the mark, the toolbar draws the chip, the bridge has its calls", () => {
  const main = src("../main/main.ts");
  assert.match(main, /const logbook = wireLogbookIpc\(\{ client, window: \(\) => win, tray: createLogbookTray\(/);
  const ipc = src("../main/logbook-ipc.ts");
  assert.match(ipc, /call\("POST", "\/api\/logbook\/indicator", mark\)/);
  assert.match(ipc, /if \(deps\.client\.isRemote\) return;/, "a remote agent's screen is not this one");
  assert.match(ipc, /ipcMain\.on\("logbook:chipVisible"/);
  const preload = src("../preload/preload.ts");
  for (const name of ["logbookStatus", "logbookAct", "logbookChipVisible", "onLogbook"]) assert.match(preload, new RegExp(`\\b${name}:`), name);
  assert.match(src("../renderer/renderer.js"), /typeof logbookChipHTML === 'function' \? logbookChipHTML\(\) : ''/);
  const html = src("../renderer/index.html");
  assert.ok(html.indexOf('src="logbook-chip.js"') < html.indexOf('src="renderer.js"'), "loaded before renderer.js");
  assert.match(html, /href="css\/logbook\.css"/);
});
