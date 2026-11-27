// ATO-2333: Record a meeting, the folder on disk (main/meeting-store.ts),
// in a temp folder, against the built output.
// Run: npm run build && npm run test:unit
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../out/main/meeting-store.js");

const root = mkdtempSync(join(tmpdir(), "mtg-store-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("ids are checked: a path from the window cannot leave the meetings folder", () => {
  assert.ok(S.isMeetingId("m-1764252300000"));
  assert.ok(S.isMeetingId("m-1764252300000-2"));
  assert.equal(S.isMeetingId("../m-1"), false);
  assert.equal(S.isMeetingId("m-1/../../x"), false);
  assert.equal(S.isMeetingId(42), false);
  const store = new S.MeetingStore(() => root);
  assert.throws(() => store.dir("../etc"));
});

test("frames are on disk as they arrive; a seal turns them into a WAV and deletes the raw file", () => {
  const store = new S.MeetingStore(() => root);
  const meta = store.create(1764252300000, "en-US");
  assert.deepEqual(store.meta(meta.id), { id: meta.id, startedAt: 1764252300000, locale: "en-US" });
  store.appendPcm(meta.id, 0, new Uint8Array(3200).fill(1));
  store.appendPcm(meta.id, 0, new Uint8Array(3200).fill(2));
  const raw = join(store.dir(meta.id), "chunk-0000.pcm");
  assert.equal(readFileSync(raw).byteLength, 6400, "each frame written at once, before any seal");
  const sealed = store.seal(meta.id, 0);
  assert.equal(sealed.duration, 0.2);
  assert.equal(existsSync(raw), false);
  const wav = readFileSync(sealed.path);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.byteLength, 44 + 6400);
  assert.equal(store.wavDuration(meta.id, 0), 0.2);
  assert.equal(store.seal(meta.id, 1), null, "nothing recorded in it");
});

test("a transcribed chunk keeps its text and loses its audio", () => {
  const store = new S.MeetingStore(() => root);
  const meta = store.create(1764252400000, "en-US");
  store.appendPcm(meta.id, 0, new Uint8Array(3200));
  store.seal(meta.id, 0);
  store.writeTranscript(meta.id, 0, 0.1, [{ start: 0, end: 0.1, text: "hi" }]);
  const names = readdirSync(store.dir(meta.id)).sort();
  assert.deepEqual(names, ["chunk-0000.json", "meta.json"]);
  assert.deepEqual(store.transcripts(meta.id), [{ index: 0, duration: 0.1, segments: [{ start: 0, end: 0.1, text: "hi" }] }]);
});

test("list: what a crash left, with its length; stale raw files are dropped; remove deletes everything", () => {
  const store = new S.MeetingStore(() => root);
  for (const m of store.list()) store.remove(m.meta.id);
  const meta = store.create(1764252500000, "de-DE");
  const dir = store.dir(meta.id);
  writeFileSync(join(dir, "chunk-0000.json"), JSON.stringify({ index: 0, duration: 20, segments: [] }));
  writeFileSync(join(dir, "chunk-0000.pcm"), Buffer.alloc(10));   // stale
  store.appendPcm(meta.id, 1, new Uint8Array(32000));            // 1 s, never sealed
  const [found] = store.list();
  assert.equal(found.meta.id, meta.id);
  assert.deepEqual(found.plan.seal, [1]);
  assert.deepEqual(found.plan.stale, [0]);
  assert.equal(found.seconds, 21);
  store.dropStale(meta.id);
  assert.equal(existsSync(join(dir, "chunk-0000.pcm")), false);
  assert.equal(existsSync(join(dir, "chunk-0001.pcm")), true, "the unsealed chunk is not stale");
  store.remove(meta.id);
  assert.equal(existsSync(dir), false);
  assert.deepEqual(store.list(), []);
});

test("a folder without a readable meta.json is not offered", () => {
  const store = new S.MeetingStore(() => root);
  const meta = store.create(1764252600000, "en-US");
  writeFileSync(join(store.dir(meta.id), "meta.json"), "{broken");
  assert.equal(store.list().some((m) => m.meta.id === meta.id), false);
  store.remove(meta.id);
});
