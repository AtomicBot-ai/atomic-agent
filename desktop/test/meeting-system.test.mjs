// ATO-2514: Record a meeting, the other side of the call in the page
// (renderer/meeting-system.js) and the Me / Them labels on live lines.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { systemAudioTarget } from "../scripts/speech-helper-plan.mjs";

const require = createRequire(import.meta.url);
const Y = require("../renderer/meeting-system.js");
const L = require("../renderer/meeting-logic.js");

test("Linux: the sound server's monitor input is picked, never a microphone", () => {
  const devices = [
    { kind: "audioinput", deviceId: "mic", label: "Built-in Audio Analog Stereo" },
    { kind: "audiooutput", deviceId: "out", label: "Monitor of nothing (an output)" },
    { kind: "audioinput", deviceId: "mon", label: "Monitor of Built-in Audio Analog Stereo" },
  ];
  assert.equal(Y.meetingPickMonitor(devices).deviceId, "mon");
  assert.equal(Y.meetingPickMonitor(devices.slice(0, 2)), null);
  assert.equal(Y.meetingPickMonitor(null), null);
});

test("the panel says plainly when only the microphone is recorded, per OS", () => {
  assert.match(Y.meetingSystemText("on", null, "darwin"), /Me and Them/);
  assert.match(Y.meetingSystemText("off", "screen-denied", "darwin"), /Privacy and Security, Screen and System Audio Recording/);
  assert.match(Y.meetingSystemText("off", "no-monitor", "linux"), /PulseAudio or PipeWire/);
  assert.match(Y.meetingSystemText("off", "failed", "win32"), /^Microphone only\./);
  assert.match(Y.meetingSystemText("off", "off", "win32"), /turned off in Settings, Meetings/);
  assert.equal(Y.meetingSystemText("idle", null, "darwin"), "");
  for (const s of ["on", "starting"].map((st) => Y.meetingSystemText(st, null, "linux"))
    .concat(["screen-denied", "failed", "off"].map((r) => Y.meetingSystemText("off", r, "darwin")))) {
    assert.doesNotMatch(s, /\u2014|Error|err\.|\/Users\//, "plain words, no long dash, no raw error");
  }
});

test("live lines are labeled Me / Them only once the call's sound is in", () => {
  assert.equal(Y.meetingWho("them", true), "Them");
  assert.equal(Y.meetingWho("me", true), "Me");
  assert.equal(Y.meetingWho("me", false), "");
  let lines = L.meetingMergeLines([], [{ start: 1, end: 2, text: "hello" }], "Me");
  lines = L.meetingMergeLines(lines, [{ start: 1, end: 2, text: "hello" }], "Them");
  assert.deepEqual(lines.map((l) => l.who), ["Me", "Them"], "the same words from both sides are two lines");
  assert.equal("who" in L.meetingMergeLines([], [{ start: 0, end: 1, text: "x" }])[0], false);
});

test("the ScreenCaptureKit helper is built for the app's macOS floor on this Mac's arch", () => {
  assert.equal(systemAudioTarget("arm64"), "arm64-apple-macos14.0");
  assert.equal(systemAudioTarget("x64"), "x86_64-apple-macos14.0");
});
