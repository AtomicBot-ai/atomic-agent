// ATO-2514: speakers told apart by voice (main/meeting-voices.ts) with a fake
// `atomic-agent diarize`, the whole-channel WAV the store keeps for it, and
// the recorder using its answer on Make notes.
// Run: npm run build && npm run test:unit
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MeetingVoices, spansOf, diarizeChannel } = require("../out/main/meeting-voices.js");
const { MeetingRecorder } = require("../out/main/meeting-recorder.js");
const { MeetingStore } = require("../out/main/meeting-store.js");

const base = mkdtempSync(join(tmpdir(), "mtg-voices-"));
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;

/** A fake agent: `answers[sub]` is a list of JSON lines and an ok flag. */
function fakeCli(answers) {
  const calls = [];
  const cli = async (args, onLine) => {
    calls.push(args.join(" "));
    const a = answers[args[1]] ?? { ok: false, lines: [] };
    for (const l of a.lines) onLine(typeof l === "string" ? l : JSON.stringify(l));
    return { ok: a.ok };
  };
  return { cli, calls };
}

const status = (installed) => ({ ok: true, lines: [{ type: "status", installed, supported: true, downloadBytes: 55_904_340 }] });

test("an agent without the diarize command, or the switch off: the recorder is told not to keep audio", async () => {
  const old = new MeetingVoices({ cli: fakeCli({}).cli, enabled: () => true, emit: () => {} });
  assert.equal(await old.prepare(), false);
  assert.equal((await old.status()).known, false);
  const off = fakeCli({ status: status(true) });
  assert.equal(await new MeetingVoices({ cli: off.cli, enabled: () => false, emit: () => {} }).prepare(), false);
  assert.deepEqual(off.calls, [], "off: the agent is not even asked");
});

test("first use: prepare starts the download with progress; diarize waits for it, then runs", async () => {
  let installed = false;
  const events = [];
  const fake = fakeCli({});
  const cli = async (args, onLine) => {
    if (args[1] === "status") return fake.cli(args, onLine).then(() => { onLine(JSON.stringify({ type: "status", installed, supported: true, downloadBytes: 1e6 })); return { ok: true }; });
    if (args[1] === "install") { onLine(JSON.stringify({ type: "progress", fraction: 0.5, totalBytes: 1e6 })); installed = true; return { ok: true }; }
    if (args[1] === "run") { onLine(JSON.stringify({ type: "progress", fraction: 0.3 })); onLine(JSON.stringify({ type: "done", spans: [{ start: 0, end: 2, speaker: 0 }, { start: 3, end: 2, speaker: 1 }] })); return { ok: true }; }
    return { ok: false };
  };
  const v = new MeetingVoices({ cli, enabled: () => true, emit: (e) => events.push(e) });
  assert.equal(await v.prepare(), true, "a missing engine still keeps the audio: the download is under way");
  const seen = [];
  const spans = await v.diarize("/t/full.wav", (f) => seen.push(f));
  assert.deepEqual(spans, [{ start: 0, end: 2, speaker: 0 }], "a span that ends before it starts is dropped");
  assert.deepEqual(seen, [0.3]);
  assert.deepEqual(events.map((e) => e.state), ["downloading", "downloading", "ready"]);
  assert.equal(events[1].fraction, 0.5);
});

test("a failed or skipped download: no spans, and the panel hears why", async () => {
  const events = [];
  const v = new MeetingVoices({ cli: fakeCli({ status: status(false), install: { ok: false, lines: [{ type: "error", code: "download" }] } }).cli, enabled: () => true, emit: (e) => events.push(e) });
  assert.deepEqual(await v.install(), { ok: false, error: "download" });
  assert.equal(events.at(-1).state, "failed");
  assert.equal(await v.diarize("/t/x.wav", () => {}), null);
  assert.equal(spansOf({ type: "error" }), null);
});

test("Skip during Make notes: diarize stops waiting for the download at once", { timeout: 5000 }, async () => {
  // An install that never ends on its own (a slow network, a CLI that does not stop on abort).
  const cli = async (args, onLine) => {
    if (args[1] === "status") { onLine(JSON.stringify({ type: "status", installed: false, supported: true, downloadBytes: 1e6 })); return { ok: true }; }
    if (args[1] === "install") return new Promise(() => {});
    return { ok: false };
  };
  const v = new MeetingVoices({ cli, enabled: () => true, emit: () => {} });
  assert.equal(await v.prepare(), true);
  assert.equal(v.downloading, true);
  const waiting = v.diarize("/t/x.wav", () => {}, 60_000);
  await new Promise((r) => setTimeout(r, 20));
  v.cancel();
  assert.equal(await waiting, null, "Make notes goes on with Me / Them");
});

test("the store keeps a channel whole as a WAV whose sizes are set before the diarizer reads it", () => {
  const store = new MeetingStore(() => join(base, `s-${++n}`));
  const meta = store.create(Date.now(), "en-US");
  assert.equal(store.fullWav(meta.id), null);
  store.appendFull(meta.id, new Uint8Array(3200), "them");
  store.appendFull(meta.id, new Uint8Array(3200), "them");
  const path = store.fullWav(meta.id, "them");
  assert.equal(path, join(store.dir(meta.id), "them", "full.wav"));
  const wav = readFileSync(path);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(40), 6400);
  assert.equal(wav.readUInt32LE(4), 36 + 6400);
});

test("diarizeChannel moves the other side's spans onto the meeting's clock", async () => {
  const store = new MeetingStore(() => join(base, `s-${++n}`));
  const meta = store.create(Date.now(), "en-US");
  store.appendFull(meta.id, new Uint8Array(3200), "them");
  const voices = { diarize: async () => [{ start: 1, end: 2, speaker: 0 }] };
  assert.deepEqual(await diarizeChannel(store, voices, meta.id, "them", 3, () => {}), [{ start: 4, end: 5, speaker: 0 }]);
  assert.equal(await diarizeChannel(store, voices, meta.id, "me", 0, () => {}), null, "no whole recording, no answer");
});

function engine() {
  let k = 0;
  return {
    id: "fake",
    async available() { return { ok: true, locale: "en-US", engine: "fake" }; },
    run() { k++; return { cancel() {}, done: Promise.resolve({ ok: true, segments: [{ start: 1, end: 3, text: `line ${k}` }, { start: 10, end: 12, text: `more ${k}` }] }) }; },
  };
}
const frame = () => new Uint8Array(3200).fill(7);

test("Make notes with voices on: the microphone is split into Speaker 1 and Speaker 2, and the audio is gone", async () => {
  const dir = join(base, `r-${++n}`);
  const store = new MeetingStore(() => join(dir, "meetings"));
  const runs = [];
  const voices = {
    prepare: async () => true,
    diarize: async (wav, onProgress) => { runs.push(existsSync(wav)); onProgress(1); return [{ start: 0, end: 5, speaker: 7 }, { start: 9, end: 13, speaker: 2 }]; },
  };
  const events = [];
  const rec = new MeetingRecorder({ store, engine: engine(), saveDir: () => join(dir, "Meetings"), emit: (e) => events.push(e), voices });
  const { id } = await rec.start();
  assert.equal(store.meta(id).voices, true);
  for (let i = 0; i < 205; i++) rec.audio(frame(), i < 200 ? 0.5 : 0);
  const res = await rec.finish(id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(runs, [true], "the diarizer read the whole microphone recording");
  assert.equal(res.method, "voice");
  assert.match(res.document, /Speaker 1: line 1[\s\S]*Speaker 2: more 1/);
  assert.match(res.document, /told apart by voice/);
  assert.ok(events.some((e) => e.type === "voices-run" && e.id === id && e.fraction === 1));
  assert.equal(existsSync(store.dir(id)), false);
});

test("voices refused (no answer): the old pause guess, and the meeting is still saved", async () => {
  const dir = join(base, `r-${++n}`);
  const store = new MeetingStore(() => join(dir, "meetings"));
  const rec = new MeetingRecorder({ store, engine: engine(), saveDir: () => join(dir, "Meetings"), emit: () => {}, voices: { prepare: async () => true, diarize: async () => null } });
  const { id } = await rec.start();
  for (let i = 0; i < 205; i++) rec.audio(frame(), i < 200 ? 0.5 : 0);
  const res = await rec.finish(id);
  assert.equal(res.ok, true);
  assert.equal(res.method, "pauses");
});
