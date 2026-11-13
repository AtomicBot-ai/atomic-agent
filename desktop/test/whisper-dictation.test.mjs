// Unit tests for ATO-1049: the whisper.cpp route of voice input on Windows
// and Linux (main/whisper-dictation.ts), against the built output.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const W = require("../out/main/whisper-dictation.js");

const only = (...paths) => (p) => paths.includes(p);

test("finds whisper-cli on PATH, then in the installer folders a GUI app misses", () => {
  assert.deepEqual(
    W.resolveWhisperBinary({ env: { PATH: "/usr/bin" }, platform: "linux", home: "/home/u", isExecutable: only("/usr/bin/whisper-cli") }),
    { found: true, path: "/usr/bin/whisper-cli" },
  );
  assert.deepEqual(
    W.resolveWhisperBinary({ env: { PATH: "/usr/bin" }, platform: "linux", home: "/home/u", isExecutable: only("/home/linuxbrew/.linuxbrew/bin/whisper-cli") }),
    { found: true, path: "/home/linuxbrew/.linuxbrew/bin/whisper-cli" },
  );
  assert.deepEqual(
    W.resolveWhisperBinary({ env: { PATH: "/usr/bin" }, platform: "linux", home: "/home/u", isExecutable: only("/home/u/.local/bin/whisper-cpp") }),
    { found: true, path: "/home/u/.local/bin/whisper-cpp" },
  );
});

test("never takes the Python `whisper` CLI", () => {
  const r = W.resolveWhisperBinary({ env: { PATH: "/usr/bin" }, platform: "linux", home: "/home/u", isExecutable: only("/usr/bin/whisper") });
  assert.equal(r.found, false);
});

test("Windows: PATH split on ';' and PATHEXT tried", () => {
  const r = W.resolveWhisperBinary({
    env: { PATH: "C:\\tools;C:\\whisper", PATHEXT: ".COM;.EXE" },
    platform: "win32",
    home: "C:\\Users\\u",
    isExecutable: only("C:\\whisper\\whisper-cli.EXE"),
  });
  assert.deepEqual(r, { found: true, path: "C:\\whisper\\whisper-cli.EXE" });
});

test("ATOMIC_AGENT_WHISPER_BIN wins, and only as an absolute executable path", () => {
  const env = { ATOMIC_AGENT_WHISPER_BIN: "/opt/w/whisper-cli", PATH: "/usr/bin" };
  assert.deepEqual(
    W.resolveWhisperBinary({ env, platform: "linux", home: "/home/u", isExecutable: only("/opt/w/whisper-cli", "/usr/bin/whisper-cli") }),
    { found: true, path: "/opt/w/whisper-cli" },
  );
  assert.equal(W.resolveWhisperBinary({ env, platform: "linux", home: "/home/u", isExecutable: () => false }).found, false);
  // A relative value is ignored, and the PATH search runs instead.
  assert.deepEqual(
    W.resolveWhisperBinary({ env: { ATOMIC_AGENT_WHISPER_BIN: "bin/w", PATH: "/usr/bin" }, platform: "linux", home: "/home/u", isExecutable: only("/usr/bin/whisper-cli") }),
    { found: true, path: "/usr/bin/whisper-cli" },
  );
});

test("the model comes from the agent's whisper folder, fast models first", () => {
  const dir = join("/state/models", "whisper");
  const o = (files) => ({ env: {}, platform: "linux", home: "/home/u", isFile: (p) => files.includes(p) });
  assert.deepEqual(W.resolveWhisperModel("/state/models", o([join(dir, "ggml-small.bin"), join(dir, "ggml-base.bin")])), { found: true, path: join(dir, "ggml-base.bin") });
  assert.deepEqual(W.resolveWhisperModel("/state/models", o([join(dir, "ggml-large-v3-turbo.bin")])), { found: true, path: join(dir, "ggml-large-v3-turbo.bin") });
  assert.deepEqual(W.resolveWhisperModel("/state/models", o([])), { found: false, detail: dir });
  assert.deepEqual(
    W.resolveWhisperModel("/state/models", { env: { ATOMIC_AGENT_WHISPER_MODEL: "/m/custom.bin" }, platform: "linux", home: "/h", isFile: only("/m/custom.bin") }),
    { found: true, path: "/m/custom.bin" },
  );
});

test("the copy the agent downloaded is taken after the env path, before PATH (decision 75)", () => {
  const managed = W.managedWhisperBinary("/state/models", "linux");
  assert.equal(managed, join("/state/models", "whisper", "bin", W.WHISPER_RELEASE_TAG, "whisper-cli"));
  assert.ok(W.managedWhisperBinary("/m", "win32").endsWith("whisper-cli.exe"));
  const base = { env: { PATH: "/usr/bin" }, platform: "linux", home: "/home/u" };
  assert.deepEqual(W.resolveWhisperBinary({ ...base, isExecutable: only(managed, "/usr/bin/whisper-cli") }, managed), { found: true, path: managed });
  assert.deepEqual(W.resolveWhisperBinary({ ...base, isExecutable: only("/usr/bin/whisper-cli") }, managed), { found: true, path: "/usr/bin/whisper-cli" });
  assert.deepEqual(
    W.resolveWhisperBinary({ ...base, env: { ...base.env, ATOMIC_AGENT_WHISPER_BIN: "/opt/whisper-cli" }, isExecutable: only(managed, "/opt/whisper-cli") }, managed),
    { found: true, path: "/opt/whisper-cli" },
  );
});

test("the agent can download whisper.cpp on Windows and Linux only", () => {
  assert.equal(W.whisperDownloadable("win32", "x64"), true);
  assert.equal(W.whisperDownloadable("linux", "arm64"), true);
  assert.equal(W.whisperDownloadable("darwin", "arm64"), false);
  assert.equal(W.whisperDownloadable("linux", "ia32"), false);
});

test("a saved default model is kept to: small saved and only base on disk counts as missing", () => {
  const data = mkdtempSync(join(tmpdir(), "dictation-default-"));
  try {
    const dir = join(data, "whisper");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ggml-base.bin"), "x");
    const o = { env: {}, platform: "linux", home: "/home/u" };
    assert.deepEqual(W.resolveWhisperModel(data, o), { found: true, path: join(dir, "ggml-base.bin") });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultModel: "small" }));
    assert.equal(W.savedWhisperModel(data), "small");
    assert.deepEqual(W.resolveWhisperModel(data, o), { found: false, detail: join(dir, "ggml-small.bin") });
    writeFileSync(join(dir, "ggml-small.bin"), "x");
    assert.deepEqual(W.resolveWhisperModel(data, o), { found: true, path: join(dir, "ggml-small.bin") });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultModel: "huge" }));
    assert.equal(W.savedWhisperModel(data), null);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("one chosen language is passed on, two let whisper detect it", () => {
  assert.equal(W.whisperLanguage(["ru-RU"]), "ru");
  assert.equal(W.whisperLanguage(["en-US", "ru-RU"]), "auto");
  assert.equal(W.whisperLanguage([]), "auto");
  assert.equal(W.whisperLanguage(["--evil"]), "auto");
  assert.deepEqual(W.whisperArgs("/m.bin", "/t/take.wav", "ru"), ["-m", "/m.bin", "-f", "/t/take.wav", "-l", "ru", "-nt", "-np"]);
});

test("every menu language counts as installed: one multilingual model hears them all", () => {
  assert.ok(W.WHISPER_LOCALES.includes("en-US"));
  assert.ok(W.WHISPER_LOCALES.includes("ru-RU"));
  for (const id of W.WHISPER_LOCALES) assert.match(id, /^[a-z]{2}-[A-Z]{2}$/);
});

test("the take becomes a 16 kHz mono 16-bit WAV", () => {
  const a = Uint8Array.from([1, 0, 2, 0]);
  const b = Uint8Array.from([3, 0]);
  const wav = W.pcmToWav([a, b]);
  assert.equal(wav.length, 44 + 6);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + 6);
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(28), 32000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), 6);
  assert.deepEqual([...wav.subarray(44)], [1, 0, 2, 0, 3, 0]);
});

test("whisper's segment lines become one line of dictation, markers dropped", () => {
  assert.equal(W.cleanTranscript(" Hello there.\r\n\n [BLANK_AUDIO]\n And again.\n"), "Hello there. And again.");
  assert.equal(W.cleanTranscript("[BLANK_AUDIO]\n"), "");
});
