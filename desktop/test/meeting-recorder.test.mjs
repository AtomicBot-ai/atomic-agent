// ATO-2333: Record a meeting, the recorder main owns (main/meeting-recorder.ts),
// with a fake transcriber and a real store in a temp folder, against the built output.
// Run: npm run build && npm run test:unit
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MeetingRecorder } = require("../out/main/meeting-recorder.js");
const { MeetingStore } = require("../out/main/meeting-store.js");

const base = mkdtempSync(join(tmpdir(), "mtg-rec-"));
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;

/** A transcriber that "hears" the chunk's file name; `fail` lists chunk names it refuses. */
function fakeEngine(o = {}) {
  const calls = [];
  return {
    calls,
    id: "fake",
    async available() { return o.unavailable ? { ok: false, reason: o.unavailable } : { ok: true, locale: "en-US", engine: "fake" }; },
    run(path, locale) {
      const name = basename(path, ".wav");
      const wavThere = existsSync(path) && readFileSync(path).toString("ascii", 0, 4) === "RIFF";
      calls.push({ name, locale, wavThere });
      const refuse = (o.fail ?? []).includes(name) && (o.failTimes ?? 1) > calls.filter((c) => c.name === name).length - 1;
      return {
        cancel() {},
        done: Promise.resolve(refuse
          ? { ok: false, error: "whisper-failed" }
          : { ok: true, segments: [{ start: 1, end: 2, text: `heard ${name}` }] }),
      };
    },
  };
}

function setup(engineOpts) {
  const dir = join(base, `case-${++n}`);
  const store = new MeetingStore(() => join(dir, "meetings"));
  const engine = fakeEngine(engineOpts);
  const events = [];
  const saveDir = join(dir, "Meetings");
  const rec = new MeetingRecorder({ store, engine, saveDir: () => saveDir, emit: (e) => events.push(e), now: () => new Date(2026, 10, 27, 14, 5).getTime() });
  return { dir, store, engine, events, saveDir, rec };
}

const LOUD = 0.5;
const frame = () => new Uint8Array(3200).fill(7);
/** 20 s of speech then half a second of quiet: exactly one chunk cut. */
function oneChunk(rec) {
  for (let i = 0; i < 200; i++) rec.audio(frame(), LOUD);
  for (let i = 0; i < 5; i++) rec.audio(frame(), 0);
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test("start arms the microphone gate; stop closes it at once", async () => {
  const { rec } = setup();
  assert.equal(rec.armed, false);
  const r = await rec.start();
  assert.equal(r.ok, true);
  assert.equal(r.locale, "en-US");
  assert.equal(rec.armed, true);
  assert.deepEqual(await rec.start(), { ok: false, error: "busy" });
  assert.equal(rec.stop().ok, true);
  assert.equal(rec.armed, false);
  assert.deepEqual(rec.stop(), { ok: false, error: "not-recording" });
});

test("no recording starts where the transcriber cannot run", async () => {
  const { rec } = setup({ unavailable: "voice-model-missing" });
  assert.deepEqual(await rec.start(), { ok: false, error: "voice-model-missing" });
  assert.equal(rec.armed, false);
});

test("frames before start, after stop, or malformed are dropped", async () => {
  const { rec, store } = setup();
  rec.audio(frame(), LOUD);
  assert.deepEqual(store.list(), []);
  const { id } = await rec.start();
  rec.audio("not audio", LOUD);
  rec.audio(new Uint8Array(3), LOUD);
  assert.deepEqual(store.names(id).sort(), ["meta.json"]);
});

test("live: a chunk is cut at a pause, transcribed from its WAV, shown on the meeting clock, and its audio deleted", async () => {
  const { rec, engine, events, store } = setup();
  const { id } = await rec.start();
  oneChunk(rec);
  await settle();
  assert.deepEqual(engine.calls.map((c) => [c.name, c.wavThere, c.locale]), [["chunk-0000", true, "en-US"]]);
  const seg = events.find((e) => e.type === "segments");
  assert.deepEqual(seg, { type: "segments", id, index: 0, segments: [{ start: 1, end: 2, text: "heard chunk-0000" }] });
  assert.equal(existsSync(store.wavPath(id, 0)), false, "the WAV is gone once its text is kept");
  // The second chunk's times start where the first one ended (20.5 s).
  oneChunk(rec);
  await settle();
  const second = events.filter((e) => e.type === "segments")[1];
  assert.deepEqual(second.segments, [{ start: 21.5, end: 22.5, text: "heard chunk-0001" }]);
  rec.stop();
});

test("Make notes: the last chunk is sealed, the transcript saved, and the meeting's audio deleted", async () => {
  const { rec, saveDir, store } = setup();
  const { id } = await rec.start();
  oneChunk(rec);
  for (let i = 0; i < 30; i++) rec.audio(frame(), LOUD);   // 3 s more, still being written
  const res = await rec.finish(id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(rec.armed, false, "finishing a live meeting stops it first");
  assert.equal(res.fileName, "Meeting 2026-11-27 14-05 transcript.txt");
  assert.equal(res.path, join(saveDir, res.fileName));
  assert.equal(res.failed, 0);
  assert.equal(res.turns, 2);
  assert.equal(res.duration, 23.5);
  const saved = readFileSync(res.path, "utf8");
  assert.equal(saved, res.document);
  assert.match(saved, /\[00:00:01\] Speaker 1: heard chunk-0000\n\[00:00:21\] Speaker 2: heard chunk-0001\n$/);
  assert.match(res.prompt, /meeting-notes skill/);
  assert.equal(existsSync(store.dir(id)), false, "no audio is kept after the transcript is saved");
  assert.deepEqual(rec.recoverable(), []);
});

test("crash: an unfinished meeting is offered at the next start and finished from what is on disk", async () => {
  const first = setup();
  const { id } = await first.rec.start();
  oneChunk(first.rec);
  await settle();
  for (let i = 0; i < 40; i++) first.rec.audio(frame(), LOUD);   // 4 s on disk, never sealed
  first.rec.kill();                                              // the app dies here
  assert.equal(first.rec.armed, false);

  // The next start: a new recorder over the same folder.
  const engine = fakeEngine();
  const rec = new MeetingRecorder({ store: first.store, engine, saveDir: () => first.saveDir, emit: () => {} });
  const offered = rec.recoverable();
  assert.equal(offered.length, 1);
  assert.equal(offered[0].id, id);
  assert.equal(offered[0].seconds, 24.5);
  const res = await rec.finish(id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(engine.calls.map((c) => c.name), ["chunk-0001"], "only the cut-short chunk is transcribed again");
  assert.match(res.document, /heard chunk-0000[\s\S]*heard chunk-0001/);
  assert.equal(existsSync(first.store.dir(id)), false);
});

test("a chunk the transcriber refuses is tried again on Make notes; refused twice, its audio is kept", async () => {
  const once = setup({ fail: ["chunk-0000"], failTimes: 1 });
  const a = await once.rec.start();
  oneChunk(once.rec);
  await settle();
  assert.ok(once.events.some((e) => e.type === "chunk-failed" && e.index === 0));
  const okRes = await once.rec.finish(a.id);
  assert.equal(okRes.failed, 0);
  assert.match(okRes.document, /heard chunk-0000/);

  const twice = setup({ fail: ["chunk-0000"], failTimes: 2 });
  const b = await twice.rec.start();
  oneChunk(twice.rec);
  const res = await twice.rec.finish(b.id);
  assert.equal(res.ok, true);
  assert.equal(res.failed, 1);
  assert.ok(existsSync(twice.store.wavPath(b.id, 0)), "the audio stays for another Finish");
});

test("Delete removes the meeting, live or left over", async () => {
  const { rec, store, events } = setup();
  const { id } = await rec.start();
  for (let i = 0; i < 10; i++) rec.audio(frame(), LOUD);
  assert.equal(rec.discard(id).ok, true);
  assert.equal(rec.armed, false);
  assert.ok(events.some((e) => e.type === "stopped" && e.reason === "discarded"));
  assert.equal(existsSync(store.dir(id)), false);
  assert.deepEqual(rec.discard("../x"), { ok: false });
  assert.deepEqual(await rec.finish("../x"), { ok: false, error: "bad-request" });
});

test("a meeting with no speech saves nothing and keeps nothing", async () => {
  const { rec, store, saveDir } = setup();
  rec.deps.engine.run = () => ({ cancel() {}, done: Promise.resolve({ ok: true, segments: [] }) });
  const { id } = await rec.start();
  oneChunk(rec);
  const res = await rec.finish(id);
  assert.equal(res.ok, true);
  assert.equal(res.empty, true);
  assert.equal(existsSync(store.dir(id)), false);
  assert.equal(existsSync(saveDir) && readdirSync(saveDir).length > 0, false);
});
