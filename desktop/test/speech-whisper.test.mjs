// Unit tests for ATO-1049 / decision 75: VoiceSession's whisper.cpp route on
// Linux, against the built output (main/speech.ts). No electron is started:
// in plain node `require("electron")` is only the binary's path, and the
// whisper branch never touches `app`.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../out/main/speech.js");
const W = require("../out/main/whisper-dictation.js");

function linuxSession(data, over = {}) {
  const bin = "/usr/bin/whisper-cli";
  return new S.VoiceSession({
    platform: "linux",
    arch: "x64",
    modelsDir: () => data,
    // whisper-cli is installed; models only count once a file is in `data`.
    lookup: () => ({ env: { PATH: "/usr/bin" }, platform: "linux", home: "/home/u", isExecutable: (p) => p === bin || (p.startsWith(data) && existsSync(p)) }),
    ...over,
  });
}

test("probe re-asks after a model-missing answer: the model lands, the mic turns on without a restart", async () => {
  const data = mkdtempSync(join(tmpdir(), "speech-probe-"));
  try {
    const v = linuxSession(data);
    const first = await v.probe();
    assert.equal(first.ok, false);
    assert.equal(first.reason, "voice-whisper-model-missing");
    assert.equal(first.canDownload, true);
    mkdirSync(W.whisperModelsDir(data), { recursive: true });
    writeFileSync(join(W.whisperModelsDir(data), "ggml-base.bin"), "x");
    const second = await v.probe();
    assert.equal(second.ok, true);
    assert.equal(second.batch, true);
    // A ready answer is cached as before.
    rmSync(join(W.whisperModelsDir(data), "ggml-base.bin"));
    assert.equal((await v.probe()).ok, true);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("probe re-asks after whisper-missing, and finds the copy the agent downloaded", async () => {
  const data = mkdtempSync(join(tmpdir(), "speech-bin-"));
  try {
    const v = new S.VoiceSession({
      platform: "linux", arch: "x64", modelsDir: () => data,
      lookup: () => ({ env: { PATH: "" }, platform: "linux", home: "/home/u", isExecutable: (p) => existsSync(p), isFile: (p) => existsSync(p) }),
    });
    const first = await v.probe();
    assert.equal(first.reason, "voice-whisper-missing");
    assert.equal(first.canDownload, true);
    const bin = W.managedWhisperBinary(data, "linux");
    mkdirSync(join(bin, ".."), { recursive: true });
    writeFileSync(bin, "");
    mkdirSync(W.whisperModelsDir(data), { recursive: true });
    writeFileSync(join(W.whisperModelsDir(data), "ggml-base.bin"), "x");
    assert.equal((await v.probe()).ok, true);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("install on Linux runs the agent's whisper install, relays progress, ends installed", async () => {
  const data = mkdtempSync(join(tmpdir(), "speech-install-"));
  try {
    const v = linuxSession(data, {
      install: (onLine) => {
        onLine(JSON.stringify({ type: "progress", item: "model", fraction: 0.5 }));
        mkdirSync(W.whisperModelsDir(data), { recursive: true });
        writeFileSync(join(W.whisperModelsDir(data), "ggml-base.bin"), "x");
        onLine(JSON.stringify({ type: "progress", item: "model", fraction: 1 }));
        onLine(JSON.stringify({ type: "done", model: "base" }));
        return { done: Promise.resolve({ ok: true, stdout: "", stderr: "" }), cancel: () => {} };
      },
    });
    assert.equal((await v.probe()).reason, "voice-whisper-model-missing");
    const events = [];
    const res = await v.install("whisper", (e) => events.push(e));
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(events.filter((e) => e.type === "install").map((e) => e.fraction), [0.5, 1]);
    assert.equal(events.at(-1).type, "installed");
    assert.equal((await v.probe()).ok, true);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("a failed install reports the agent's error and leaves the mic off", async () => {
  const data = mkdtempSync(join(tmpdir(), "speech-install-bad-"));
  try {
    const v = linuxSession(data, {
      install: (onLine) => {
        onLine(JSON.stringify({ type: "error", code: "download", message: "did not match its published SHA-256" }));
        return { done: Promise.resolve({ ok: false, stdout: "", stderr: "", error: "exited with code 1" }), cancel: () => {} };
      },
    });
    const events = [];
    const res = await v.install("whisper", (e) => events.push(e));
    assert.deepEqual(res, { ok: false, error: "download" });
    assert.equal(events.at(-1).type, "error");
    assert.match(events.at(-1).message, /SHA-256/);
    assert.equal((await v.probe()).reason, "voice-whisper-model-missing");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
