// ATO-2514: the recorder with two channels (main/meeting-recorder.ts): the
// microphone is Me, the other side of the call is Them, recorded into the
// meeting's them/ folder on its own clock, put together on Make notes.
// Run: npm run build && npm run test:unit
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MeetingRecorder } = require("../out/main/meeting-recorder.js");
const { MeetingStore } = require("../out/main/meeting-store.js");

const base = mkdtempSync(join(tmpdir(), "mtg-ch-"));
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;

/** Hears "<channel> <chunk>", or the text `say` gives for a chunk. */
function fakeEngine(say = () => null) {
  const calls = [];
  return {
    calls,
    id: "fake",
    async available() { return { ok: true, locale: "en-US", engine: "fake" }; },
    run(path) {
      const ch = basename(dirname(path)) === "them" ? "them" : "me";
      const name = basename(path, ".wav");
      calls.push(`${ch}/${name}`);
      const text = say(ch, name) ?? `${ch} ${name}`;
      return { cancel() {}, done: Promise.resolve({ ok: true, segments: [{ start: 1, end: 2, text }] }) };
    },
  };
}

function setup(say) {
  const dir = join(base, `case-${++n}`);
  const store = new MeetingStore(() => join(dir, "meetings"));
  const engine = fakeEngine(say);
  const events = [];
  const saveDir = join(dir, "Meetings");
  const rec = new MeetingRecorder({ store, engine, saveDir: () => saveDir, emit: (e) => events.push(e), now: () => new Date(2026, 10, 27, 14, 5).getTime() });
  return { store, engine, events, rec };
}

const frame = () => new Uint8Array(3200).fill(7);
function speech(rec, ch, frames = 200) {
  for (let i = 0; i < frames; i++) rec.audio(frame(), 0.5, ch);
  for (let i = 0; i < 5; i++) rec.audio(frame(), 0, ch);
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test("the other side of the call is its own channel, on the meeting's clock from its first frame", async () => {
  const { rec, store, events } = setup();
  const { id } = await rec.start();
  for (let i = 0; i < 30; i++) rec.audio(frame(), 0.5);   // 3 s of microphone first
  speech(rec, "them");
  await settle();
  assert.equal(store.meta(id).themLead, 3, "the call's clock starts 3 s in");
  assert.ok(existsSync(join(store.dir(id), "them")), "its chunks live in them/");
  const seg = events.find((e) => e.type === "segments" && e.channel === "them");
  assert.deepEqual(seg.segments, [{ start: 4, end: 5, text: "them chunk-0000" }], "1 s into its chunk, 3 s into the meeting");
  rec.stop();
});

test("Make notes: Me and Them in one transcript, the header says so, and all audio is gone", async () => {
  const { rec, store } = setup();
  const { id } = await rec.start();
  speech(rec, "me");
  speech(rec, "them");
  const res = await rec.finish(id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.method, "channels");
  assert.match(res.document, /Speakers: Me is this computer's microphone, Them is the call's sound/);
  assert.match(res.document, /\] Me: me chunk-0000/);
  assert.match(res.document, /\] Them: them chunk-0000/);
  assert.match(res.prompt, /Them is the other side of the call/);
  assert.equal(existsSync(store.dir(id)), false);
});

test("the microphone hearing the call is not written twice", async () => {
  const { rec } = setup(() => "we ship the release on friday morning");
  const { id } = await rec.start();
  speech(rec, "them");   // lead 0: both chunks line up in time
  speech(rec, "me");
  const res = await rec.finish(id);
  assert.equal((res.document.match(/we ship the release/g) || []).length, 1);
  assert.match(res.document, /\] Them: we ship the release/);
});

test("crash: the call's unfinished chunk is picked up from them/ too", async () => {
  const first = setup();
  const { id } = await first.rec.start();
  speech(first.rec, "me");
  for (let i = 0; i < 40; i++) first.rec.audio(frame(), 0.5, "them");   // never sealed
  first.rec.kill();
  const engine = fakeEngine();
  const rec = new MeetingRecorder({ store: first.store, engine, saveDir: () => join(base, "x"), emit: () => {} });
  const res = await rec.finish(id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(engine.calls.includes("them/chunk-0000"), engine.calls.join(","));
  assert.match(res.document, /Them: them chunk-0000/);
});

test("a microphone-only meeting keeps the pause guess and has no them/ folder", async () => {
  const { rec, store } = setup();
  const { id } = await rec.start();
  speech(rec, "me");
  assert.deepEqual(readdirSync(store.dir(id)).filter((x) => x === "them"), []);
  const res = await rec.finish(id);
  assert.equal(res.method, "pauses");
  assert.match(res.document, /Speaker 1: me chunk-0000/);
});
