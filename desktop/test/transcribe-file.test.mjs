// ATO-1074: an audio file transcribed on this computer, with timestamps.
// main/transcribe-file.ts (against the built output) with a fake speech
// helper run through node, and the pure half of renderer/transcribe.js.
// Run: npm run build && npm run test:unit
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/transcribe-file.js");
const R = require("../renderer/transcribe.js");

const dir = mkdtempSync(join(tmpdir(), "trx-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("timestamps are always HH:MM:SS", () => {
  assert.equal(M.formatTimestamp(0), "00:00:00");
  assert.equal(M.formatTimestamp(83.9), "00:01:23");
  assert.equal(M.formatTimestamp(3600 + 62), "01:01:02");
  assert.equal(M.formatTimestamp(-4), "00:00:00");
  assert.equal(M.formatTimestamp(NaN), "00:00:00");
  assert.equal(M.formatTimestamp(100 * 3600), "100:00:00");
});

test("the transcript is one [HH:MM:SS] line per spoken segment", () => {
  const text = M.formatTranscript([
    { start: 1.2, end: 4, text: " Hello  there. " },
    { start: 5, end: 6, text: "   " },
    { start: 83.4, end: 90, text: "Next\npoint." },
  ]);
  assert.equal(text, "[00:00:01] Hello there.\n[00:01:23] Next point.");
  const doc = M.transcriptDocument("meeting.m4a", "en-US", [{ start: 0, end: 1, text: "Hi" }]);
  assert.match(doc, /^Transcript of meeting\.m4a \(en-US, made on this computer\)\n\n\[00:00:00\] Hi\n$/);
  assert.match(M.transcriptDocument("a.wav", "en-US", []), /\(no speech was heard\)/);
  assert.equal(M.transcriptFileName("/x/Team sync.m4a"), "Team sync transcript.txt");
  assert.equal(M.transcriptFileName(""), "audio transcript.txt");
});

test("helper lines parse into events; noise and bad segments are dropped", () => {
  assert.deepEqual(M.parseHelperLine('{"type":"segment","start":1.5,"end":3,"text":"hi"}'),
    { type: "segment", segment: { start: 1.5, end: 3, text: "hi" } });
  // An end before the start is clamped, a missing end is the start.
  assert.deepEqual(M.parseHelperLine('{"type":"segment","start":4,"end":2,"text":"x"}').segment, { start: 4, end: 4, text: "x" });
  assert.deepEqual(M.parseHelperLine('{"type":"segment","start":4,"text":"x"}').segment, { start: 4, end: 4, text: "x" });
  assert.equal(M.parseHelperLine('{"type":"segment","start":4,"text":"  "}'), null);
  assert.equal(M.parseHelperLine('{"type":"segment","text":"no start"}'), null);
  assert.deepEqual(M.parseHelperLine('{"type":"progress","fraction":1.7}'), { type: "progress", fraction: 1 });
  assert.deepEqual(M.parseHelperLine('{"type":"error","code":"open-file","message":"nope"}'), { type: "error", code: "open-file", message: "nope" });
  assert.deepEqual(M.parseHelperLine('{"type":"done","duration":12.5}'), { type: "done", duration: 12.5 });
  assert.equal(M.parseHelperLine("objc[123]: warning"), null);
  assert.equal(M.parseHelperLine("{broken"), null);
  assert.equal(M.parseHelperLine('{"type":"partial","text":"x"}'), null);
  assert.equal(M.parseHelperLine(""), null);
});

test("a line split across two reads is kept whole", () => {
  const got = [];
  const s = M.lineSplitter((l) => got.push(l));
  s.push('{"a":1}\n{"b"');
  s.push(':2}\n\n');
  s.push('{"c":3}');
  assert.deepEqual(got, ['{"a":1}', '{"b":2}']);
  s.end();
  assert.deepEqual(got, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("the file is heard in the first voice language that is installed", () => {
  assert.equal(M.pickFileLocale(["ru-RU", "en-US"], ["en-US", "ru-RU"]), "ru-RU");
  assert.equal(M.pickFileLocale(["de-DE", "en-GB"], ["en-GB", "en-US"]), "en-GB");
  assert.equal(M.pickFileLocale([], ["fr-FR", "en-US"]), "en-US");
  assert.equal(M.pickFileLocale(["de-DE"], ["fr-FR"]), "fr-FR");
  assert.equal(M.pickFileLocale(["en-US"], []), null);
  assert.equal(M.isTranscribableAudio("/a/b.M4A"), true);
  assert.equal(M.isTranscribableAudio("/a/b.mov"), false);
  assert.equal(M.isTranscribableAudio("/a/b"), false);
});

/* A stand-in for native/atomic-speech: same argv, same NDJSON. */
const fake = join(dir, "fake-speech.cjs");
writeFileSync(fake, `
const [mode, path, locale] = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (mode !== "--file") { out({type: "error", code: "args"}); process.exit(1); }
if (path.endsWith("fail.wav")) { out({type: "error", code: "open-file", message: "cannot open"}); process.exit(0); }
if (path.endsWith("crash.wav")) { process.stderr.write("boom"); process.exit(3); }
out({type: "file-ready", locale, engine: "speech", duration: 100});
if (path.endsWith("slow.wav")) { out({type: "segment", start: 0, end: 2, text: "first"}); setInterval(() => {}, 1000); return; }
// A segment split mid-line across two writes, then progress, then done.
process.stdout.write('{"type":"segment","start":1.2,"end":4');
setTimeout(() => {
  process.stdout.write(',"text":"Hello team."}\\n');
  out({type: "progress", fraction: 0.5});
  out({type: "segment", start: 83, end: 100, text: "Last point."});
  out({type: "progress", fraction: 1});
  out({type: "done", duration: 100});
}, 20);
`);

function engine(over = {}) {
  return M.appleSpeechEngine({
    command: () => process.execPath,
    prefixArgs: [fake],
    probe: async () => ({ ok: true, installed: ["en-US", "ru-RU"] }),
    chosen: () => ["ru-RU"],
    ...over,
  });
}
const audio = (name) => join(dir, name);
for (const n of ["ok.wav", "fail.wav", "crash.wav", "slow.wav"]) writeFileSync(audio(n), "RIFF");

test("availability names the engine, the language, or the reason", async () => {
  assert.deepEqual(await engine().available(), { ok: true, locale: "ru-RU", engine: "apple-speech" });
  assert.deepEqual(await engine({ probe: async () => ({ ok: false, reason: "voice-os-too-old", installed: [] }) }).available(),
    { ok: false, reason: "voice-os-too-old", engine: "apple-speech" });
  assert.deepEqual(await engine({ probe: async () => ({ ok: true, installed: [] }) }).available(),
    { ok: false, reason: "voice-model-missing", engine: "apple-speech" });
  const t = new M.FileTranscriber(engine({ probe: async () => { throw new Error("x"); } }));
  assert.equal((await t.available()).ok, false);
});

test("a file is transcribed with progress, segments and a saved-ready document", async () => {
  const t = new M.FileTranscriber(engine());
  const events = [];
  const res = await t.transcribe({ job: "j1", path: audio("ok.wav") }, (job, ev) => events.push({ job, ...ev }));
  assert.equal(res.ok, true);
  assert.equal(res.locale, "ru-RU");
  assert.equal(res.engine, "apple-speech");
  assert.equal(res.duration, 100);
  assert.deepEqual(res.segments, [{ start: 1.2, end: 4, text: "Hello team." }, { start: 83, end: 100, text: "Last point." }]);
  assert.equal(res.text, "[00:00:01] Hello team.\n[00:01:23] Last point.");
  assert.equal(res.fileName, "ok transcript.txt");
  assert.match(res.document, /^Transcript of ok\.wav \(ru-RU, made on this computer\)\n\n\[00:00:01\] Hello team\./);
  assert.ok(events.every((e) => e.job === "j1"));
  assert.deepEqual(events.filter((e) => e.type === "progress").map((e) => e.fraction), [0.5, 1]);
  assert.equal(events.filter((e) => e.type === "segment").length, 2);
});

test("a helper error, a crash and a missing helper come back as failures", async () => {
  const t = new M.FileTranscriber(engine());
  const fail = await t.transcribe({ job: "j", path: audio("fail.wav") }, () => {});
  assert.deepEqual([fail.ok, fail.error, fail.message], [false, "open-file", "cannot open"]);
  const crash = await t.transcribe({ job: "j", path: audio("crash.wav") }, () => {});
  assert.deepEqual([crash.ok, crash.error, crash.message], [false, "helper-stopped", "boom"]);
  const none = await new M.FileTranscriber(engine({ command: () => join(dir, "no-such-helper") }))
    .transcribe({ job: "j", path: audio("ok.wav") }, () => {});
  assert.deepEqual([none.ok, none.error], [false, "voice-helper-missing"]);
});

test("bad requests are refused before anything is spawned", async () => {
  let ran = 0;
  const counting = { id: "x", available: async () => ({ ok: true, locale: "en-US" }), run: () => { ran++; return { cancel() {}, done: Promise.resolve({ ok: true }) }; } };
  const t = new M.FileTranscriber(counting);
  assert.equal((await t.transcribe({ job: "j", path: "relative.wav" }, () => {})).error, "not-audio");
  assert.equal((await t.transcribe({ job: "j", path: audio("notes.txt") }, () => {})).error, "not-audio");
  assert.equal((await t.transcribe({ job: "j", path: audio("gone.wav") }, () => {})).error, "missing");
  assert.equal((await t.transcribe({ job: "", path: audio("ok.wav") }, () => {})).error, "bad-request");
  assert.equal((await t.transcribe(null, () => {})).error, "bad-request");
  assert.equal(ran, 0);
});

test("cancel stops the run; one file at a time", async () => {
  const t = new M.FileTranscriber(engine());
  const first = [];
  const p = t.transcribe({ job: "slow", path: audio("slow.wav") }, (_job, ev) => first.push(ev));
  // Poll until the helper has spoken, rather than sleeping a fixed time.
  for (let i = 0; i < 200 && !first.length; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(first.length, 1, "the slow helper emitted its first segment");
  assert.equal((await t.transcribe({ job: "other", path: audio("ok.wav") }, () => {})).error, "busy");
  assert.deepEqual(t.cancel("other"), { ok: false });
  assert.deepEqual(t.cancel("slow"), { ok: true });
  const res = await p;
  assert.deepEqual([res.ok, res.cancelled], [false, true]);
  // Free again afterwards.
  assert.equal((await t.transcribe({ job: "again", path: audio("ok.wav") }, () => {})).ok, true);
  assert.deepEqual(t.cancel("again"), { ok: false });
});

test("the renderer's words: progress, reasons, failures; no long dashes", async () => {
  assert.equal(R.trxProgressText(0), "Transcribing…");
  assert.equal(R.trxProgressText(0.426), "Transcribing… 43%");
  assert.equal(R.trxProgressText(7), "Transcribing… 100%");
  assert.equal(R.trxReasonText("voice-os-too-old"), "Transcribing audio needs macOS 26 or later");
  assert.equal(R.trxReasonText("voice-not-macos"), "Audio files are not supported yet");
  assert.match(R.trxReasonText("voice-model-missing"), /language in voice input/);
  assert.match(R.trxErrorText("busy"), /Another file/);
  assert.equal(R.trxErrorText("voice-os-too-old"), R.trxReasonText("voice-os-too-old"));
  // Off the app (no bridge) the action does not exist.
  assert.equal(R.trxOffer(), false);
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../renderer/transcribe.js", import.meta.url), "utf8");
  assert.equal(src.includes("—"), false);
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('src="attachments.js"') < html.indexOf('src="transcribe.js"'));
  assert.ok(html.indexOf('src="transcribe.js"') < html.indexOf('src="renderer.js"'));
});

/* ---------------- ATO-1076: the whisper.cpp engine (Windows, Linux) ---------------- */

test("whisper-cli lines: timed segments, progress, noise dropped", () => {
  assert.deepEqual(M.parseWhisperSegment("[00:01:23.400 --> 00:01:27.120]   Next point."),
    { start: 83.4, end: 87.12, text: "Next point." });
  assert.deepEqual(M.parseWhisperSegment("[01:00:00,000 --> 01:00:02,5]  Late"), { start: 3600, end: 3602.5, text: "Late" });
  assert.equal(M.parseWhisperSegment("[00:00:00.000 --> 00:00:02.000]   [BLANK_AUDIO]"), null);
  assert.equal(M.parseWhisperSegment("[00:00:00.000 --> 00:00:02.000]  (music)"), null);
  assert.equal(M.parseWhisperSegment("[00:00:00.000 --> 00:00:02.000]   "), null);
  assert.equal(M.parseWhisperSegment("whisper_init_from_file_with_params_no_state: loading model"), null);
  assert.equal(M.parseWhisperProgress("whisper_print_progress_callback: progress =  42%"), 0.42);
  assert.equal(M.parseWhisperProgress("whisper_print_progress_callback: progress = 100%"), 1);
  assert.equal(M.parseWhisperProgress("system_info: n_threads = 4"), null);
  assert.deepEqual(M.whisperFileArgs("/m/ggml-base.bin", "/t/a.wav", "ru"), ["-m", "/m/ggml-base.bin", "-f", "/t/a.wav", "-l", "ru", "-pp"]);
  const ff = M.ffmpegWavArgs("/in/call.m4a", "/t/audio.wav");
  assert.deepEqual(ff.slice(ff.indexOf("-i")), ["-i", "/in/call.m4a", "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "/t/audio.wav"]);
  assert.equal(M.isTranscribableAudio("/a/call.ogg", M.WHISPER_TRANSCRIBE_EXTS), true);
  assert.equal(M.isTranscribableAudio("/a/call.ogg"), false, "the Apple route keeps its own list");
  assert.equal(M.isTranscribableAudio("/a/clip.mov", M.WHISPER_TRANSCRIBE_EXTS), false);
});

test("ffmpeg is found on PATH, with .exe on Windows", () => {
  const seen = [];
  const isExecutable = (p) => { seen.push(p); return p === "C:\\tools\\ffmpeg.exe" || p === "/opt/bin/ffmpeg"; };
  assert.equal(M.findOnPath("ffmpeg", { env: { Path: "C:\\x;C:\\tools" }, platform: "win32", home: "C:\\Users\\a", isExecutable }), "C:\\tools\\ffmpeg.exe");
  assert.equal(M.findOnPath("ffmpeg", { env: { PATH: "/usr/bin:/opt/bin" }, platform: "linux", home: "/home/a", isExecutable }), "/opt/bin/ffmpeg");
  assert.equal(M.findOnPath("ffmpeg", { env: { PATH: "/usr/bin" }, platform: "linux", home: "/home/a", isExecutable: () => false }), null);
});

/* Stand-ins for whisper-cli and ffmpeg: same argv, same output shapes. */
const fakeWhisper = join(dir, "fake-whisper.cjs");
writeFileSync(fakeWhisper, `
const a = process.argv.slice(2);
const f = a[a.indexOf("-f") + 1];
const lang = a[a.indexOf("-l") + 1];
if (!a.includes("-pp") || !a.includes("-m")) { process.stderr.write("bad args"); process.exit(2); }
if (f.endsWith("broken.wav")) { process.stderr.write("error: failed to read WAV file\\n"); process.exit(1); }
if (f.endsWith("slow.wav")) { process.stdout.write("[00:00:00.000 --> 00:00:02.000]  first\\n"); setInterval(() => {}, 1000); return; }
process.stderr.write("whisper_init_from_file: loading model\\n");
process.stdout.write("[00:00:01.200 --> 00:00:04.000]   Hello team (" + lang + ").\\n[00:00:04.000 --> 00:00:0");
setTimeout(() => {
  process.stdout.write("5.000]   [BLANK_AUDIO]\\n");
  process.stderr.write("whisper_print_progress_callback: progress =  50%\\n");
  process.stdout.write("[00:01:23.000 --> 00:01:40.000]   Last point.\\n");
  process.stderr.write("whisper_print_progress_callback: progress = 100%\\n");
  process.exit(0);
}, 20);
`);
const fakeFfmpeg = join(dir, "fake-ffmpeg.cjs");
writeFileSync(fakeFfmpeg, `
const a = process.argv.slice(2);
const input = a[a.indexOf("-i") + 1];
const out = a[a.length - 1];
if (input.endsWith("bad.m4a")) { process.stderr.write("Invalid data found when processing input"); process.exit(1); }
require("fs").writeFileSync(out, "RIFF");
process.exit(0);
`);
for (const n of ["meet.m4a", "bad.m4a", "rec.wav", "broken.wav", "call.ogg"]) writeFileSync(audio(n), "x");

function wengine(over = {}) {
  return M.whisperFileEngine({
    probe: async () => ({ ok: true }),
    paths: () => ({ bin: process.execPath, model: "/models/whisper/ggml-base.bin" }),
    chosen: () => ["ru-RU"],
    ffmpeg: () => process.execPath,
    prefixArgs: { whisper: [fakeWhisper], ffmpeg: [fakeFfmpeg] },
    tempRoot: () => dir,
    ...over,
  });
}

test("whisper availability follows the voice probe", async () => {
  assert.deepEqual(await wengine().available(), { ok: true, locale: "ru-RU", engine: "whisper" });
  assert.deepEqual(await wengine({ chosen: () => [] }).available(), { ok: true, locale: "en-US", engine: "whisper" });
  assert.deepEqual(await wengine({ probe: async () => ({ ok: false, reason: "voice-whisper-model-missing" }) }).available(),
    { ok: false, reason: "voice-whisper-model-missing", engine: "whisper" });
  assert.deepEqual(await wengine({ paths: () => null }).available(), { ok: false, reason: "voice-whisper-missing", engine: "whisper" });
  assert.match(R.trxReasonText("voice-whisper-model-missing"), /microphone once/);
  assert.match(R.trxErrorText("needs-ffmpeg"), /ffmpeg/);
});

test("whisper: an m4a goes through ffmpeg, segments stream, the temp WAV is removed", async () => {
  const { readdirSync } = await import("node:fs");
  const before = readdirSync(dir).filter((n) => n.startsWith("atomic-transcribe-")).length;
  const t = new M.FileTranscriber(wengine());
  const events = [];
  const res = await t.transcribe({ job: "w1", path: audio("meet.m4a") }, (job, ev) => events.push({ job, ...ev }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.engine, "whisper");
  assert.equal(res.locale, "ru-RU");
  assert.deepEqual(res.segments, [{ start: 1.2, end: 4, text: "Hello team (ru)." }, { start: 83, end: 100, text: "Last point." }]);
  assert.equal(res.duration, 100);
  assert.equal(res.text, "[00:00:01] Hello team (ru).\n[00:01:23] Last point.");
  assert.equal(res.fileName, "meet transcript.txt");
  assert.deepEqual(events.filter((e) => e.type === "progress").map((e) => e.fraction), [0.5, 1]);
  assert.equal(events.filter((e) => e.type === "segment").length, 2);
  assert.equal(readdirSync(dir).filter((n) => n.startsWith("atomic-transcribe-")).length, before, "temp folder deleted");
});

test("whisper: two chosen languages are heard as auto; a WAV without ffmpeg runs as is", async () => {
  const t = new M.FileTranscriber(wengine({ chosen: () => ["en-US", "ru-RU"], ffmpeg: () => null }));
  const res = await t.transcribe({ job: "w2", path: audio("rec.wav") }, () => {});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.segments[0].text, "Hello team (auto).");
});

test("whisper: failures come back worded, never as a crash", async () => {
  const noFf = new M.FileTranscriber(wengine({ ffmpeg: () => null }));
  assert.equal((await noFf.transcribe({ job: "w", path: audio("call.ogg") }, () => {})).error, "needs-ffmpeg");
  const t = new M.FileTranscriber(wengine());
  const bad = await t.transcribe({ job: "w", path: audio("bad.m4a") }, () => {});
  assert.deepEqual([bad.ok, bad.error], [false, "open-file"]);
  assert.match(bad.message, /Invalid data/);
  const broken = await new M.FileTranscriber(wengine({ ffmpeg: () => null })).transcribe({ job: "w", path: audio("broken.wav") }, () => {});
  assert.deepEqual([broken.ok, broken.error], [false, "whisper-failed"]);
  assert.match(broken.message, /failed to read WAV/);
  assert.equal((await t.transcribe({ job: "w", path: audio("clip.mov") }, () => {})).error, "not-audio");
});

test("whisper: cancel kills the run", async () => {
  const t = new M.FileTranscriber(wengine({ ffmpeg: () => null }));
  const seen = [];
  const p = t.transcribe({ job: "ws", path: audio("slow.wav") }, (_j, ev) => seen.push(ev));
  for (let i = 0; i < 200 && !seen.length; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(seen.length, 1);
  assert.deepEqual(t.cancel("ws"), { ok: true });
  const res = await p;
  assert.deepEqual([res.ok, res.cancelled], [false, true]);
});
