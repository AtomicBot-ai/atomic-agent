// ATO-2333: Record a meeting, the transcript put back together
// (main/meeting-transcript.ts), against the built output.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const T = require("../out/main/meeting-transcript.js");

test("chunks go back on the meeting's clock, in index order, by the durations before them", () => {
  const segs = T.assembleSegments([
    { index: 1, duration: 30, segments: [{ start: 2, end: 4, text: "second chunk" }] },
    { index: 0, duration: 25, segments: [{ start: 1, end: 3, text: " first  chunk " }, { start: 5, end: 6, text: "  " }] },
    { index: 2, duration: 10, segments: [{ start: 0, end: 1, text: "third" }] },
  ]);
  assert.deepEqual(segs, [
    { start: 1, end: 3, text: "first chunk" },
    { start: 27, end: 29, text: "second chunk" },
    { start: 55, end: 56, text: "third" },
  ]);
  assert.deepEqual(T.shiftSegments([{ start: 1, end: 2, text: "x" }], -5), [{ start: 1, end: 2, text: "x" }]);
});

test("a pause of two seconds or more starts a new turn, and the speaker alternates", () => {
  const turns = T.speakerTurns([
    { start: 0, end: 2, text: "Hi all." },
    { start: 2.5, end: 4, text: "Let's start." },
    { start: 7, end: 9, text: "Sounds good." },
    { start: 12, end: 13, text: "Item one." },
  ]);
  assert.deepEqual(turns, [
    { speaker: "Speaker 1", start: 0, end: 4, text: "Hi all. Let's start." },
    { speaker: "Speaker 2", start: 7, end: 9, text: "Sounds good." },
    { speaker: "Speaker 1", start: 12, end: 13, text: "Item one." },
  ]);
  assert.deepEqual(T.speakerTurns([]), []);
  assert.equal(T.speakerTurns([{ start: 0, end: 1, text: "a" }, { start: 1.5, end: 2, text: "b" }], 0.4).length, 2, "the pause is a parameter");
});

test("the saved file: header, the guessed-speakers note, one line per turn", () => {
  const startedAt = new Date(2026, 10, 27, 14, 5).getTime();
  assert.equal(T.meetingFileName(startedAt), "Meeting 2026-11-27 14-05 transcript.txt");
  const doc = T.meetingDocument({
    startedAt, duration: 754, locale: "en-US",
    turns: [{ speaker: "Speaker 1", start: 83, end: 90, text: "We ship on Friday." }],
  });
  assert.match(doc, /^Meeting transcript, recorded on this computer\n/);
  assert.match(doc, /\nDate: 2026-11-27 14:05\n/);
  assert.match(doc, /\nLength: 00:12:34\n/);
  assert.match(doc, /\nLanguage: en-US\n/);
  assert.match(doc, /Speakers: guessed from pauses/);
  assert.match(doc, /\n\n\[00:01:23\] Speaker 1: We ship on Friday\.\n$/);
  assert.match(T.meetingDocument({ startedAt, duration: 0, locale: "", turns: [] }), /\(no speech was heard\)/);
});

test("the Make notes message names the skill, the file, and asks before scheduling", () => {
  const p = T.minutesPrompt("Meeting 2026-11-27 14-05 transcript.txt");
  assert.match(p, /meeting-notes skill/);
  assert.match(p, /"Meeting 2026-11-27 14-05 transcript\.txt"/);
  assert.match(p, /action items with owners/);
  assert.match(p, /Do not schedule anything without a yes/);
  assert.doesNotMatch(p, /\u2014/, "no long dashes");
});
