// ATO-2333: Record a meeting, the pure half of the panel (renderer/meeting-logic.js).
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require("../renderer/meeting-logic.js");

test("the clock under the red dot", () => {
  assert.equal(L.meetingClock(0), "00:00");
  assert.equal(L.meetingClock(754.9), "12:34");
  assert.equal(L.meetingClock(3723), "1:02:03");
  assert.equal(L.meetingClock(-3), "00:00");
  assert.equal(L.meetingClock(NaN), "00:00");
});

test("live lines stay in time order, without blanks or repeats", () => {
  let lines = L.meetingMergeLines([], [{ start: 21.5, end: 22, text: "second" }]);
  lines = L.meetingMergeLines(lines, [{ start: 1, end: 2, text: " first  one " }, { start: 3, end: 4, text: "  " }, { text: "no time" }]);
  lines = L.meetingMergeLines(lines, [{ start: 21.5, end: 22, text: "second" }]);
  assert.deepEqual(lines, [
    { start: 1, end: 2, text: "first one" },
    { start: 21.5, end: 22, text: "second" },
  ]);
  assert.deepEqual(L.meetingMergeLines(null, null), []);
});

test("errors are sentences, with a default", () => {
  assert.match(L.meetingErrorText("mic-denied"), /Microphone access is turned off/);
  assert.match(L.meetingErrorText("voice-model-missing"), /speech model/);
  assert.equal(L.meetingErrorText("whatever"), "Something went wrong with the recording");
  for (const code of ["mic-denied", "mic-failed", "busy", "disk", "missing", "voice-os-too-old", "voice-whisper-missing", "voice-helper-failed"]) {
    assert.doesNotMatch(L.meetingErrorText(code), /\u2014/, code);
  }
});

test("the unfinished-meeting card", () => {
  const at = new Date(2026, 10, 27, 14, 5).getTime();
  assert.equal(L.meetingWhen(at), "27 Nov, 14:05");
  assert.equal(L.meetingLength(20), "under a minute");
  assert.equal(L.meetingLength(12 * 60), "12 min");
  assert.equal(L.meetingLength(65 * 60), "1 h 5 min");
  assert.equal(L.meetingLength(120 * 60), "2 h");
  assert.equal(L.meetingRecoverText([]), "");
  assert.equal(L.meetingRecoverText([{ id: "m-1", startedAt: at, seconds: 720 }]), "A meeting from 27 Nov, 14:05, 12 min recorded, was not finished.");
  assert.match(L.meetingRecoverText([{ startedAt: at, seconds: 60 }, { startedAt: at, seconds: 5 }]), /\(and 1 more\)\.$/);
});

test("the notes are asked for only once the transcript chip is ready", () => {
  assert.equal(L.meetingReadyToSend([]), false);
  assert.equal(L.meetingReadyToSend([{ status: "preparing" }]), false);
  assert.equal(L.meetingReadyToSend([{ status: "ready" }, { status: "preparing" }]), false);
  assert.equal(L.meetingReadyToSend([{ status: "ready" }, { status: "error" }]), true);
});

// ATO-2749: the meeting UI/UX fixes.
test("mic denied: the path of the computer it is on, spelled as elsewhere, as a sentence", () => {
  const mac = L.meetingMicDeniedText("darwin");
  assert.match(mac, /System Settings › Privacy & Security › Microphone/);
  assert.doesNotMatch(mac, /Privacy and Security/);
  const win = L.meetingMicDeniedText("win32");
  assert.match(win, /Settings › Privacy & security › Microphone/);
  assert.doesNotMatch(win, /System Settings/);
  const linux = L.meetingMicDeniedText("linux");
  assert.doesNotMatch(linux, /System Settings|Privacy/);
  for (const s of [mac, win, linux]) { assert.match(s, /\.$/); assert.doesNotMatch(s, /\u2014/); }
  assert.equal(L.meetingErrorText("mic-denied"), mac);
  assert.equal(L.meetingErrorText("mic-denied", "win32"), win);
});

test("mic denied: Open Settings only where the OS has one pane, and only with the bridge", () => {
  const esc = (s) => String(s);
  assert.equal(L.meetingCanOpenMicSettings("darwin"), true);
  assert.equal(L.meetingCanOpenMicSettings("win32"), true);
  assert.equal(L.meetingCanOpenMicSettings("linux"), false);
  assert.match(L.meetingDeniedCardHTML("darwin", true, esc), /data-mtg="micsettings">Open Settings</);
  assert.match(L.meetingDeniedCardHTML("win32", true, esc), /Open Settings/);
  assert.doesNotMatch(L.meetingDeniedCardHTML("linux", true, esc), /Open Settings/);
  assert.doesNotMatch(L.meetingDeniedCardHTML("darwin", false, esc), /Open Settings/);
  assert.match(L.meetingDeniedCardHTML("linux", false, esc), /data-mtg="retry"/);
  assert.match(L.meetingDeniedCardHTML("linux", false, esc), /data-mtg="deniedx"/);
  for (const code of ["mic-denied", "NotAllowedError", "SecurityError"]) assert.equal(L.meetingMicDenied(code), true, code);
  for (const code of ["mic-failed", "busy", "", undefined, "NotFoundError"]) assert.equal(L.meetingMicDenied(code), false, String(code));
});

test("Delete recording asks first; the toast says deleted only when it was", () => {
  const c = L.meetingDeleteConfirmHTML("m-1", (s) => String(s));
  assert.match(c, /Delete this recording\?/);
  assert.match(c, /cannot be undone/);
  assert.match(c, /data-mtg="delno">Keep</);
  assert.match(c, /class="btn btn-df sm" data-mtg="delyes" data-mtg-id="m-1">Delete recording</);
  assert.deepEqual(L.meetingDiscardToast({ ok: true }), { t: "Recording deleted", s: "Its audio and transcript are gone from this computer.", kind: "" });
  for (const res of [{ ok: false }, null, undefined]) {
    const t = L.meetingDiscardToast(res);
    assert.equal(t.kind, "bad");
    assert.equal(t.t, "Could not delete the recording");
    assert.doesNotMatch(t.t + t.s, /Recording deleted|gone/);
  }
});
