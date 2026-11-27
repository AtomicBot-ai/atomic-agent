// ATO-2514: the wiring of the other side of a call: the helper is compiled and
// shipped, main runs it and answers Windows loopback only while recording, the
// bridge and the page carry it.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("the ScreenCaptureKit helper is compiled and packaged on macOS", () => {
  assert.match(src("../scripts/build-speech-helper.mjs"), /systemAudioTarget\(\), systemAudioSrc, "-o", systemAudioOut/);
  assert.match(src("../electron-builder.cjs"), /"from": "out\/native\/atomic-system-audio",\s*"to": "native\/atomic-system-audio"/);
  const swift = src("../native/atomic-system-audio.swift");
  assert.match(swift, /cfg\.capturesAudio = true/);
  assert.match(swift, /cfg\.sampleRate = 16000/);
  assert.match(swift, /"screen-denied"/);
  assert.match(swift, /excludingApplications: skip/, "the app's own sound is left out");
});

test("main: the routes, the loopback answer and the permission gate", () => {
  const main = src("../main/main.ts");
  assert.match(main, /wireMeetingSystemIpc\(meeting, \{ emit: \(ev\) => send\("app:meeting", ev\) \}\);/);
  assert.match(main, /wireMeetingLoopback\(window\.webContents\.session, \(\) => meeting\.armed\);/);
  assert.match(main, /if \(permission === "display-capture"\) return displayCaptureAllowed\(meeting\.armed\);/);
  const ipc = src("../main/meeting-system-ipc.ts");
  for (const ch of ["system-start", "system-stop", "open-screen-settings"]) assert.match(ipc, new RegExp(`ipcMain\\.handle\\("meeting:${ch}"`), ch);
  assert.match(ipc, /ipcMain\.on\("meeting:system-audio", \(_event, chunk: unknown, peak: unknown\) => recorder\.audio\(chunk, peak, "them"\)\)/);
  assert.match(ipc, /return armed && systemAudioMode\(platform\) === "loopback";/, "loopback only on Windows, only while recording");
  assert.match(ipc, /callback\(screen \? \{ video: screen, audio: "loopback" \} : \{\}\)/);
  assert.match(ipc, /if \(!recorder\.armed\) \{ if \(capture === mine\) stop\(\); return; \}/, "a recording main ended stops the helper");
});

test("the bridge and the page", () => {
  const pre = src("../preload/preload.ts");
  assert.match(pre, /meetingSystemStart: \(\) => ipcRenderer\.invoke\("meeting:system-start"\)/);
  assert.match(pre, /meetingSystemAudio: \(chunk: Uint8Array, peak: number\) => ipcRenderer\.send\("meeting:system-audio", chunk, peak\)/);
  assert.match(pre, /meetingSystemStop: \(\) => ipcRenderer\.invoke\("meeting:system-stop"\)/);
  assert.match(pre, /meetingOpenScreenSettings: \(\) => ipcRenderer\.invoke\("meeting:open-screen-settings"\)/);
  const html = src("../renderer/index.html");
  const at = (s) => html.indexOf(s);
  assert.ok(at('src="meeting-logic.js"') < at('src="meeting-system.js"') && at('src="meeting-system.js"') < at('src="meeting-panel.js"'));
  const panel = src("../renderer/meeting-panel.js");
  assert.match(panel, /if \(typeof mtgSystemStart === 'function'\) mtgSystemStart\(\);/, "started once the microphone is open");
  assert.match(panel, /if \(typeof mtgSystemStop === 'function'\) mtgSystemStop\(\);/, "released with the microphone");
  assert.match(panel, /meetingWho\(ev\.channel, MTGS\.state === 'on'\)/);
});
