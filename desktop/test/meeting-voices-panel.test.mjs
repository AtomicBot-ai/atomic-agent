// ATO-2514: the panel's lines about speakers by voice (renderer/meeting-voices.js),
// and the wiring of the diarizer routes.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const V = require("../renderer/meeting-voices.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("the first-use download says how much, and that it happens once", () => {
  assert.equal(V.meetingDownloadText(0.5, 56_000_000), "Getting the speaker model, 28 of 56 MB. It is downloaded once and stays on this computer.");
  assert.match(V.meetingDownloadText(0.25, 0), /25%/);
  assert.match(V.meetingVoicesText({ download: null, failed: true }, "recording"), /could not be downloaded/);
  assert.equal(V.meetingVoicesText({ running: 0.4 }, "finishing"), "Telling speakers apart, 40%.");
  assert.equal(V.meetingVoicesText({ download: null, failed: false }, "recording"), "");
});

test("voices off (the default): a stopped recording offers it once, linked to Settings, Meetings", () => {
  globalThis.esc = globalThis.esc || ((x) => String(x));
  const html = V.meetingVoicesOfferHTML({ offer: true, on: false }, "stopped");
  assert.match(html, /Tell voices apart: Download \(60 MB\)/);
  assert.match(html, /data-act="settings:meetings"/);
  assert.equal(V.meetingVoicesOfferHTML({ offer: true, on: false }, "recording"), "");
  assert.equal(V.meetingVoicesOfferHTML({ offer: false, on: false }, "stopped"), "");
  assert.equal(V.meetingVoicesOfferHTML({ offer: true, on: true }, "stopped"), "");
});

test("wiring: one MeetingVoices shared by the recorder and the routes", () => {
  assert.match(src("../main/meeting-ipc.ts"), /voices: meetingVoicesFor\(emit\),/);
  assert.match(src("../main/main.ts"), /wireMeetingVoicesIpc\(meetingVoicesFor\(\(ev\) => send\("app:meeting", ev\)\)\);/);
  const ipc = src("../main/meeting-voices-ipc.ts");
  for (const ch of ["voices-status", "voices-install", "voices-cancel", "voices-remove"]) assert.match(ipc, new RegExp(`ipcMain\\.handle\\("meeting:${ch}"`), ch);
  assert.match(ipc, /if \(!shared\) \{/);
  const pre = src("../preload/preload.ts");
  for (const m of ["meetingVoicesStatus", "meetingVoicesInstall", "meetingVoicesCancel", "meetingVoicesRemove"]) assert.match(pre, new RegExp(`${m}: \\(\\) => ipcRenderer\\.invoke`), m);
  const html = src("../renderer/index.html");
  assert.ok(html.indexOf('src="meeting-system.js"') < html.indexOf('src="meeting-voices.js"') && html.indexOf('src="meeting-voices.js"') < html.indexOf('src="meeting-panel.js"'));
  assert.match(src("../renderer/meeting-panel.js"), /typeof mtgVoicesHTML === 'function' \? mtgVoicesHTML\(\) : ''/);
});
