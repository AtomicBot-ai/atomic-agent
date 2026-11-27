// ATO-2333: Record a meeting, the chunking and crash-recovery plan
// (main/meeting-plan.ts), against the built output.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../out/main/meeting-plan.js");

const FRAME = 3200; // 100 ms of 16 kHz mono s16le

test("a chunk is not cut before the minimum, however quiet it is", () => {
  const p = new P.ChunkPlanner();
  const minFrames = (P.MIN_CHUNK_SECONDS * P.MEETING_BYTES_PER_SECOND) / FRAME;
  for (let i = 0; i < minFrames - 1; i++) assert.equal(p.push(FRAME, 0), false, `frame ${i}`);
});

test("after the minimum, half a second of quiet cuts the chunk", () => {
  const p = new P.ChunkPlanner();
  const minFrames = (P.MIN_CHUNK_SECONDS * P.MEETING_BYTES_PER_SECOND) / FRAME;
  for (let i = 0; i < minFrames; i++) assert.equal(p.push(FRAME, 0.5), false);
  for (let i = 0; i < P.QUIET_FRAMES_TO_CUT - 1; i++) assert.equal(p.push(FRAME, 0.001), false);
  assert.equal(p.push(FRAME, 0.001), true, "the fifth quiet frame cuts");
  assert.equal(p.pending(), 0, "the next chunk starts empty");
});

test("a loud frame resets the quiet run", () => {
  const p = new P.ChunkPlanner(FRAME, 100 * FRAME);
  p.push(FRAME, 0.5);
  for (let i = 0; i < 4; i++) p.push(FRAME, 0);
  assert.equal(p.push(FRAME, 0.9), false);
  for (let i = 0; i < 4; i++) assert.equal(p.push(FRAME, 0), false);
  assert.equal(p.push(FRAME, 0), true);
});

test("the maximum cuts mid-speech, so the live transcript never trails far", () => {
  const p = new P.ChunkPlanner();
  const maxFrames = (P.MAX_CHUNK_SECONDS * P.MEETING_BYTES_PER_SECOND) / FRAME;
  let cutAt = -1;
  for (let i = 0; i < maxFrames + 5; i++) if (p.push(FRAME, 0.8)) { cutAt = i; break; }
  assert.equal(cutAt, maxFrames - 1);
});

test("a missing or odd peak counts as loud (never a reason to cut)", () => {
  const p = new P.ChunkPlanner(FRAME, 100 * FRAME);
  for (let i = 0; i < 10; i++) assert.equal(p.push(FRAME, NaN), false);
});

test("chunk names round-trip; anything else is ignored", () => {
  assert.equal(P.chunkBase(3), "chunk-0003");
  assert.equal(P.chunkBase(12345), "chunk-12345");
  assert.deepEqual(P.parseChunkName("chunk-0003.wav"), { index: 3, ext: "wav" });
  assert.deepEqual(P.parseChunkName("chunk-0010.pcm"), { index: 10, ext: "pcm" });
  assert.equal(P.parseChunkName("chunk-0003.wav.part"), null);
  assert.equal(P.parseChunkName("meta.json"), null);
  assert.equal(P.parseChunkName("../chunk-0001.wav"), null);
});

test("recovery: each chunk once, at its most advanced state", () => {
  const plan = P.planRecovery([
    "meta.json",
    "chunk-0000.json",
    "chunk-0001.json", "chunk-0001.pcm",   // crash between JSON and the raw file going: stale
    "chunk-0002.wav",                      // sealed, not transcribed
    "chunk-0003.wav", "chunk-0003.pcm",    // crash between seal and delete: stale
    "chunk-0004.pcm",                      // cut short while recording
    "chunk-0005.wav.part",                 // half-written, never read
  ]);
  assert.deepEqual(plan.done, [0, 1]);
  assert.deepEqual(plan.transcribe, [2, 3]);
  assert.deepEqual(plan.seal, [4]);
  assert.deepEqual(plan.stale, [1, 3]);
  assert.equal(plan.next, 5);
  assert.deepEqual(P.planRecovery([]), { seal: [], transcribe: [], done: [], stale: [], next: 0 });
});

test("durations and offsets", () => {
  assert.equal(P.pcmSeconds(64000), 2);
  assert.equal(P.wavSeconds(44 + 32000), 1);
  assert.equal(P.wavSeconds(10), 0);
  assert.deepEqual(P.chunkOffsets([20, 30.5, NaN, 10]), [0, 20, 50.5, 50.5]);
});

test("frames from the renderer are checked", () => {
  assert.ok(P.checkFrame(new Uint8Array(3200)));
  assert.ok(P.checkFrame(Buffer.alloc(3200)), "a Buffer is a Uint8Array");
  assert.equal(P.checkFrame(new Uint8Array(0)), null);
  assert.equal(P.checkFrame(new Uint8Array(3201)), null, "half a sample");
  assert.equal(P.checkFrame(new Uint8Array(P.MEETING_MAX_FRAME_BYTES + 2)), null);
  assert.equal(P.checkFrame([1, 2]), null);
  assert.equal(P.checkFrame("pcm"), null);
});
