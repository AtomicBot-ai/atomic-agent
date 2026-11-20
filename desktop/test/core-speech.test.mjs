// ATO-1167: a neural reading voice through Atomic Core's audio module.
// main/core-speech.ts against the built output, with a fake Core client,
// plus the pure halves of renderer/tts.js and renderer/tts-settings.js.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/core-speech.js");
const T = require("../renderer/tts.js");
const S = require("../renderer/tts-settings.js");

/* conf's models/audio.json, cut down to what the parser reads. */
const CATALOG = {
  schema_version: 1,
  models: [
    {
      id: "qwen3-tts-1.7b-customvoice", name: "Qwen3-TTS 1.7B", description: "Nine voices.", mode: "speech",
      engines: ["audio-cpp"], family: "qwen3_tts", task: "tts", repo: "audio-cpp/audio.cpp-gguf",
      revision: "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8",
      quants: [{ id: "q8_0", path: "Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf",
        filename: "qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf", bytes: 2817055200, sha256: "c8ac3f94b6e73f137c0e7ecc9270bc8faec7a476ff799b87e48844d1d0987ac3", recommended: true }],
      default_voice: "vivian", defaults: { seed: 42 },
    },
    {
      id: "moss-tts-nano-100m", name: "MOSS-TTS-Nano 100M", description: "Tiny.", mode: "speech",
      engines: ["audio-cpp"], family: "moss_tts_nano", task: "tts", repo: "audio-cpp/audio.cpp-gguf", revision: "874fcb41",
      quants: [{ id: "f16", path: "MOSS/a-f16.gguf", filename: "a-f16.gguf", bytes: 400 }, { id: "q8_0", path: "MOSS/a-q8_0.gguf", filename: "a-q8_0.gguf", bytes: 193, sha256: "x", recommended: true }],
      default_voice: null, defaults: { seed: 42 },
    },
    { id: "ace-step-1.5-turbo", name: "ACE-Step", mode: "music", engines: ["audio-cpp"], family: "ace_step", task: "gen", repo: "a/b", revision: "r", quants: [{ id: "q", path: "x.gguf", filename: "x.gguf", bytes: 1 }] },
    { id: "evil", name: "Evil", mode: "speech", engines: ["audio-cpp"], family: "f", task: "tts", repo: "a/b", revision: "r", quants: [{ id: "q", path: "../../etc/x.gguf", filename: "x.gguf", bytes: 1 }] },
    { id: "other-engine", mode: "speech", engines: ["mlx"], family: "f", task: "tts", repo: "a/b", revision: "r", quants: [{ id: "q", path: "x.gguf", filename: "x.gguf", bytes: 1 }] },
  ],
};

test("Core has audio from 0.20.6 on", () => {
  assert.equal(M.coreHasAudio("0.18.6"), false);
  assert.equal(M.coreHasAudio("0.20.5"), false);
  assert.equal(M.coreHasAudio("0.20.6"), true);
  assert.equal(M.coreHasAudio("v0.24.1"), true);
  assert.equal(M.coreHasAudio("1.0.0"), true);
  assert.equal(M.coreHasAudio("nonsense"), false);
  assert.equal(M.coreHasAudio(""), false);
});

test("the catalog gives its speech models with the recommended quant; music, other engines and bad paths are left out", () => {
  const ms = M.parseSpeechCatalog(CATALOG);
  assert.deepEqual(ms.map((m) => m.id), ["qwen3-tts-1.7b-customvoice", "moss-tts-nano-100m"]);
  assert.equal(ms[1].file.quant, "q8_0");
  assert.equal(ms[1].file.sha256, null, "a hash that is not 64 hex is no hash");
  assert.equal(ms[0].defaultVoice, "vivian");
  assert.equal(M.speechModelId(ms[0]), "qwen3-tts-1.7b-customvoice:q8_0");
  assert.equal(M.speechModelUrl(ms[0]),
    "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8/Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf");
  assert.deepEqual(M.loadRequest(ms[0], "/managed/audio/models/Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf"), {
    modelId: "qwen3-tts-1.7b-customvoice:q8_0", displayName: "Qwen3-TTS 1.7B", mode: "speech",
    file: "/managed/audio/models/Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf",
    family: "qwen3_tts", task: "tts", defaultRequestOptions: { seed: 42 }, defaultVoice: "vivian",
  });
  assert.equal("defaultVoice" in M.loadRequest(ms[1], "/x.gguf"), false);
  assert.deepEqual(M.parseSpeechCatalog(null), []);
  assert.deepEqual(M.parseSpeechCatalog({ models: "x" }), []);
});

test("text is cut into whole sentences under the limit", () => {
  assert.deepEqual(M.speechPieces(""), []);
  assert.deepEqual(M.speechPieces("One. Two!  Three?", 100), ["One. Two! Three?"]);
  assert.deepEqual(M.speechPieces("First sentence here. Second sentence here.", 25), ["First sentence here.", "Second sentence here."]);
  const long = "word ".repeat(50).trim();
  const parts = M.speechPieces(long, 60);
  assert.ok(parts.every((p) => p.length <= 60), JSON.stringify(parts));
  assert.equal(parts.join(" "), long);
  // The renderer's copy cuts the same way.
  for (const t of ["One. Two!  Three?", long, "Привет. Как дела? «Хорошо»."]) assert.deepEqual(T.ttsPieces(t, 60), M.speechPieces(t, 60));
});

/* A fake Core: answers the audio and engine-build routes, records every call. */
function fakeCore(over = {}) {
  const calls = [];
  const state = { active: "active" in over ? over.active : { tag: "v0.9.3", backend_id: "macos-arm64" }, loaded: over.loaded ?? null, polls: 0 };
  const client = {
    instanceId: over.instanceId ?? "core-1",
    async call(path, body, opts = {}) {
      calls.push({ path, body, method: opts.method ?? (body === undefined ? "GET" : "POST") });
      if (opts.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (path === "/engine-builds/audio-cpp/catalog") return { active: state.active, host_backend_id: over.hostBackend === undefined ? "macos-arm64" : over.hostBackend, host_reason: "no build for this CPU" };
      if (path === "/engine-builds/audio-cpp/install") { state.active = { tag: "v0.9.3" }; return { installed: true }; }
      if (path === "/audio/status") return { model: { state: state.loaded ? "loaded" : "unloaded", loaded: state.loaded } };
      if (path === "/audio/model/load") { state.loaded = { modelId: body.modelId }; return { model: state.loaded }; }
      if (path === "/audio/jobs") {
        if (over.jobFails) return { id: "j1", state: "failed", output: null, error: { code: "ENGINE_FAILED", message: "the engine stopped" } };
        return { id: "j1", state: "queued", output: null };
      }
      if (path === "/audio/jobs/j1") {
        state.polls++;
        if (over.hang) return { job: { id: "j1", state: "generating", output: null } };
        return { job: state.polls < 2 ? { id: "j1", state: "generating", output: null } : { id: "j1", state: "completed", output: { id: "j1", path: "/core/audios/j1.wav", sampleRate: 24000 } } };
      }
      if (path === "/audio/jobs/j1/cancel") return { cancelled: true, serverStopped: true };
      if (path.startsWith("/audio/gallery/")) return {};
      throw new Error(`unexpected ${path}`);
    },
  };
  return { client, calls, state };
}

function speech(over = {}) {
  const core = over.core ?? fakeCore();
  const downloads = [];
  const sizes = over.sizes ?? { "qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf": 2817055200 };
  const s = new M.CoreSpeech({
    coreVersion: over.coreVersion ?? "0.24.1",
    client: async () => core.client,
    modelsRoot: () => over.modelsRoot ?? "/data/audio/models",
    catalog: over.catalog ?? (async () => CATALOG),
    download: over.download ?? (async (target, opts) => { downloads.push({ target, root: opts.root }); opts.onBytes(target.bytes); opts.onVerifying(); sizes[target.savePath.split("/").pop()] = target.bytes; }),
    chosen: () => over.chosen ?? "",
    fileSize: over.fileSize ?? (async (p) => { const n = sizes[p.split(/[\\/]/).pop()]; if (n === undefined) throw new Error("ENOENT"); return n; }),
    readFile: async () => Buffer.from("RIFFwav"),
    pollMs: 1,
    jobTimeoutMs: over.jobTimeoutMs ?? 5000,
    taskId: () => "task-1",
  });
  return { s, core, downloads, sizes };
}

test("status: too old a Core, no catalog, not downloaded, no engine, ready", async () => {
  assert.equal((await speech({ coreVersion: "0.18.6" }).s.status()).reason, "core-too-old");
  assert.equal((await speech({ catalog: async () => { throw new Error("offline"); } }).s.status()).reason, "catalog-unavailable");
  const none = await speech({ sizes: {} }).s.status();
  assert.equal(none.reason, "model-not-downloaded");
  assert.deepEqual(none.model, { id: "qwen3-tts-1.7b-customvoice", name: "Qwen3-TTS 1.7B", bytes: 2817055200 });
  assert.deepEqual(none.models.map((m) => [m.id, m.downloaded]), [["qwen3-tts-1.7b-customvoice", false], ["moss-tts-nano-100m", false]]);
  assert.equal((await speech({ core: fakeCore({ active: null }) }).s.status()).reason, "engine-not-installed");
  const ok = await speech().s.status();
  assert.equal(ok.ok, true);
  // The chosen model wins when the catalog has it.
  assert.equal((await speech({ chosen: "moss-tts-nano-100m", sizes: { "a-q8_0.gguf": 193 } }).s.status()).model.id, "moss-tts-nano-100m");
});

test("prepare installs the engine, then downloads the model into the voices folder", async () => {
  const core = fakeCore({ active: null });
  const { s, downloads } = speech({ core, sizes: {} });
  const events = [];
  const res = await s.prepare(undefined, (ev) => events.push(ev));
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(core.calls.find((c) => c.path.endsWith("/install")).body, { task_id: "task-1" });
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].root, "/data/audio/models");
  assert.match(downloads[0].target.savePath, /audio[\\/]models[\\/]Qwen3-TTS-12Hz-1\.7B-CustomVoice-GGUF[\\/]qwen3-tts/);
  assert.equal(downloads[0].target.sha256, "c8ac3f94b6e73f137c0e7ecc9270bc8faec7a476ff799b87e48844d1d0987ac3");
  assert.deepEqual(events.map((e) => e.type), ["engine", "engine", "download", "verifying"]);
  // Nothing to do the second time.
  const again = await s.prepare(undefined, () => {});
  assert.deepEqual(again, { ok: true });
  assert.equal(downloads.length, 1);
});

test("prepare: no engine build for this computer, too old a Core, a failed download", async () => {
  assert.equal((await speech({ core: fakeCore({ active: null, hostBackend: null }) }).s.prepare(undefined, () => {})).error, "engine-unsupported");
  assert.equal((await speech({ coreVersion: "0.18.6" }).s.prepare(undefined, () => {})).error, "core-too-old");
  const failing = speech({ sizes: {}, download: async () => { throw Object.assign(new Error("Hugging Face answered 403"), { code: "HTTP_403" }); } });
  assert.deepEqual(await failing.s.prepare(undefined, () => {}), { ok: false, error: "HTTP_403", message: "Hugging Face answered 403" });
});

test("speak loads the model once, polls the job, returns the WAV and clears Core's gallery", async () => {
  const { s, core } = speech();
  const res = await s.speak("Hello there.");
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.audio, "data:audio/wav;base64," + Buffer.from("RIFFwav").toString("base64"));
  assert.equal(res.sampleRate, 24000);
  const job = core.calls.find((c) => c.path === "/audio/jobs");
  assert.deepEqual(job.body, { mode: "speech", request: { text: "Hello there." } });
  assert.deepEqual(core.calls.find((c) => c.path === "/audio/gallery/j1").method, "DELETE");
  assert.equal(core.calls.filter((c) => c.path === "/audio/model/load").length, 1);
  core.state.polls = 0;
  assert.equal((await s.speak("Again.")).ok, true);
  assert.equal(core.calls.filter((c) => c.path === "/audio/model/load").length, 1, "loaded once per Core");
});

test("speak loads the model by its absolute path, outside Core's own folder", async () => {
  const { s, core } = speech();
  assert.equal((await s.speak("Hi.")).ok, true);
  const load = core.calls.find((c) => c.path === "/audio/model/load");
  assert.match(load.body.file, /^[\/]data[\/]audio[\/]models[\/]Qwen3-TTS-12Hz-1\.7B-CustomVoice-GGUF[\/]qwen3-tts-12hz-1\.7b-customvoice-q8_0\.gguf$/);
});

test("a Core version bump keeps the downloaded voice", async () => {
  const root = M.speechModelsDir("/managed");
  assert.doesNotMatch(root, /versions/);
  // One disk, keyed by full path, so a file under another folder is not found.
  const disk = new Map();
  const fileSize = async (p) => { if (!disk.has(p)) throw new Error("ENOENT"); return disk.get(p); };
  const download = async (target, opts) => { opts.onBytes(target.bytes); disk.set(target.savePath, target.bytes); };
  const first = speech({ coreVersion: "0.20.6", modelsRoot: root, fileSize, download });
  assert.deepEqual(await first.s.prepare(undefined, () => {}), { ok: true });
  assert.equal(disk.size, 1);
  assert.ok([...disk.keys()][0].startsWith(root));
  let downloadedAgain = false;
  const next = speech({ coreVersion: "0.20.7", modelsRoot: root, fileSize, download: async () => { downloadedAgain = true; } });
  assert.equal((await next.s.status()).ok, true);
  assert.deepEqual(await next.s.prepare(undefined, () => {}), { ok: true });
  assert.equal(downloadedAgain, false, "no second download after the bump");
});

test("speak: a model Core already has loaded is not loaded again", async () => {
  const core = fakeCore({ loaded: { modelId: "qwen3-tts-1.7b-customvoice:q8_0" } });
  const { s } = speech({ core });
  assert.equal((await s.speak("Hi.")).ok, true);
  assert.equal(core.calls.some((c) => c.path === "/audio/model/load"), false);
});

test("speak refuses empty text, an old Core and a missing model; a failed job is worded", async () => {
  assert.equal((await speech().s.speak("   ")).error, "empty");
  assert.equal((await speech().s.speak(42)).error, "empty");
  assert.equal((await speech({ coreVersion: "0.18.6" }).s.speak("Hi")).error, "core-too-old");
  assert.equal((await speech({ sizes: {} }).s.speak("Hi")).error, "model-not-downloaded");
  const failed = await speech({ core: fakeCore({ jobFails: true }) }).s.speak("Hi");
  assert.deepEqual([failed.ok, failed.error, failed.message], [false, "ENGINE_FAILED", "the engine stopped"]);
});

test("cancel stops the piece being made and tells Core; a hung job times out", async () => {
  const core = fakeCore({ hang: true });
  const { s } = speech({ core });
  const p = s.speak("A long sentence.");
  for (let i = 0; i < 200 && core.state.polls === 0; i++) await new Promise((r) => setTimeout(r, 5));
  s.cancel();
  const res = await p;
  assert.deepEqual([res.ok, res.cancelled], [false, true]);
  for (let i = 0; i < 200 && !core.calls.some((c) => c.path === "/audio/jobs/j1/cancel"); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(core.calls.some((c) => c.path === "/audio/jobs/j1/cancel"));
  const slow = speech({ core: fakeCore({ hang: true }), jobTimeoutMs: 30 });
  assert.equal((await slow.s.speak("Hi")).error, "timeout");
});

test("the settings' words", () => {
  assert.match(S.ttsCoreStatusText({ ok: false, reason: "core-too-old" }), /system voices read/);
  assert.match(S.ttsCoreStatusText({ ok: false, reason: "model-not-downloaded", model: { name: "Qwen3-TTS 1.7B", bytes: 2817055200 } }), /^Download Qwen3-TTS 1\.7B \(2\.6 GB\)/);
  assert.match(S.ttsCoreStatusText({ ok: true, model: { name: "MOSS" } }), /^MOSS reads replies on this computer/);
  assert.equal(S.ttsGb(193343328), "184 MB");
  assert.match(S.ttsCoreStatusText(null), /Checking/);
});
