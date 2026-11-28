// ATO-2514: who said what in a meeting (main/meeting-speakers.ts): Me / Them from
// the two channels, voices from the diarizer, pauses as the fallback, and echoes.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../out/main/meeting-speakers.js");
const T = require("../out/main/meeting-transcript.js");

const seg = (start, end, text) => ({ start, end, text });

test("two channels: Me and Them interleave on one clock", () => {
  const { turns, method } = S.buildTurns({
    me: [seg(0, 2, "Hi, can you hear me?"), seg(10, 12, "Great, let's start.")],
    them: [seg(3, 5, "Yes, loud and clear."), seg(5.5, 7, "One second.")],
  });
  assert.equal(method, "channels");
  assert.deepEqual(turns.map((t) => [t.speaker, t.text]), [
    ["Me", "Hi, can you hear me?"],
    ["Them", "Yes, loud and clear. One second."],
    ["Me", "Great, let's start."],
  ]);
});

test("an echo of the call in the microphone is dropped, real overlap talk is kept", () => {
  const them = S.labelSegments([seg(3, 6, "The budget for next quarter is ten thousand")], "Them");
  const me = S.labelSegments([
    seg(3.4, 6.2, "the budget for next quarter is ten thousand"),   // the speakers, heard by the mic
    seg(4, 5, "Wait, which budget?"),                               // said over them
    seg(20, 21, "the budget for next quarter"),                     // the same words much later: not an echo
  ], "Me");
  assert.deepEqual(S.dropEchoes(me, them).map((s) => s.text), ["Wait, which budget?", "the budget for next quarter"]);
});

test("voice: each segment takes the speaker it overlaps most, numbered by who talks first", () => {
  const spans = [{ start: 0, end: 4, speaker: 3 }, { start: 4, end: 9, speaker: 1 }, { start: 9, end: 12, speaker: 3 }];
  const out = S.assignSpeakers([seg(0.5, 3, "a"), seg(3.5, 8, "b"), seg(9.5, 11, "c"), seg(30, 31, "late")], spans, (n) => `Speaker ${n}`);
  assert.deepEqual(out.map((s) => s.speaker), ["Speaker 1", "Speaker 2", "Speaker 1", "Speaker 1"]);
  const { turns, method } = S.buildTurns({ me: [seg(0.5, 3, "a"), seg(3.5, 8, "b")], them: null, voice: spans });
  assert.equal(method, "voice");
  assert.deepEqual(turns.map((t) => t.speaker), ["Speaker 1", "Speaker 2"]);
});

test("a group call: the diarizer splits Them into Them 1 and Them 2; one voice stays Them", () => {
  const them = [seg(1, 3, "I think so"), seg(4, 6, "I disagree")];
  const two = S.buildTurns({ me: [], them, voice: [{ start: 0, end: 3.5, speaker: 0 }, { start: 3.5, end: 7, speaker: 1 }] });
  assert.equal(two.method, "channels+voice");
  assert.deepEqual(two.turns.map((t) => t.speaker), ["Them 1", "Them 2"]);
  const one = S.buildTurns({ me: [], them, voice: [{ start: 0, end: 7, speaker: 0 }] });
  assert.equal(one.method, "channels");
  assert.deepEqual(one.turns.map((t) => t.speaker), ["Them"]);
});

test("no second channel and no diarizer: the old pause guess", () => {
  const me = [seg(0, 1, "one"), seg(5, 6, "two")];
  const { turns, method } = S.buildTurns({ me, them: null, voice: null });
  assert.equal(method, "pauses");
  assert.deepEqual(turns, T.speakerTurns(me));
});

test("the saved file and the notes prompt say how the speakers were found", () => {
  assert.match(T.speakersLine("channels"), /Me is this computer's microphone, Them is the call's sound/);
  assert.match(T.speakersLine("voice"), /told apart by voice/);
  assert.match(T.speakersLine(), /guessed from pauses/);
  assert.match(T.minutesPrompt("x.txt", "channels"), /Me is the person who recorded the meeting; Them is the other side of the call/);
  assert.match(T.minutesPrompt("x.txt"), /guessed from pauses/);
});
