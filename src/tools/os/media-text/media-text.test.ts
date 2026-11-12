import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommandOptions, CommandResult } from "../../../sandbox/command-runner.js";
import {
  extractMediaText,
  mediaKindForPath,
  normaliseText,
  probeMediaTextEngines,
  type BinaryProbe,
  type CommandRunner,
} from "./media-text.js";

interface Call {
  command: string;
  args: string[];
  options: CommandOptions;
}

function result(partial: Partial<CommandResult> = {}): CommandResult {
  return {
    command: "",
    args: [],
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    inputTruncated: false,
    ...partial,
  };
}

function fakeRunner(answers: Record<string, Partial<CommandResult>>): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    return result({ command, args, ...(answers[command] ?? {}) });
  };
  return { run, calls };
}

function whichOf(...present: string[]): BinaryProbe {
  return async (bin) => present.includes(bin);
}

let dir: string;
let png: string;
let wav: string;
let mp3: string;
let model: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-text-test-"));
  png = join(dir, "scan.PNG");
  wav = join(dir, "memo.wav");
  mp3 = join(dir, "call.mp3");
  model = join(dir, "ggml-base.bin");
  await Promise.all([png, wav, mp3, model].map((p) => writeFile(p, "x")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("mediaKindForPath", () => {
  it("classes photos and audio by extension, case-insensitively", () => {
    expect(mediaKindForPath("/a/b/photo.JPG")).toBe("image");
    expect(mediaKindForPath("x.webp")).toBe("image");
    expect(mediaKindForPath("voice.ogg")).toBe("audio");
    expect(mediaKindForPath("talk.M4A")).toBe("audio");
    expect(mediaKindForPath("doc.pdf")).toBeNull();
    expect(mediaKindForPath("noext")).toBeNull();
  });
});

describe("extractMediaText", () => {
  it("is off by default and runs nothing", async () => {
    const { run, calls } = fakeRunner({});
    const out = await extractMediaText(png, { run, which: whichOf("tesseract") });
    expect(out).toEqual({ status: "skipped", kind: "image", reason: "disabled" });
    expect(calls).toHaveLength(0);
  });

  it("skips files it does not handle", async () => {
    const out = await extractMediaText(join(dir, "notes.txt"), { enabled: true });
    expect(out).toMatchObject({ status: "skipped", kind: null, reason: "unsupported" });
  });

  it("skips files over the size cap", async () => {
    await writeFile(png, Buffer.alloc(64));
    const out = await extractMediaText(png, { enabled: true, maxBytes: 10, which: whichOf("tesseract") });
    expect(out).toMatchObject({ status: "skipped", reason: "too-large" });
  });

  it("OCRs a photo with tesseract to stdout in the chosen languages", async () => {
    const { run, calls } = fakeRunner({ tesseract: { stdout: "  Invoice 42  \n\n\n\nTotal: 10 EUR\f" } });
    const out = await extractMediaText(png, {
      enabled: true,
      ocrLanguages: "eng+rus",
      run,
      which: whichOf("tesseract"),
    });
    expect(out).toEqual({ status: "ok", kind: "image", engine: "tesseract", text: "Invoice 42\n\nTotal: 10 EUR", truncated: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([png, "stdout", "-l", "eng+rus"]);
  });

  it("skips a photo when tesseract is not installed", async () => {
    const { run, calls } = fakeRunner({});
    const out = await extractMediaText(png, { enabled: true, run, which: whichOf() });
    expect(out).toMatchObject({ status: "skipped", kind: "image", reason: "no-engine" });
    expect(calls).toHaveLength(0);
  });

  it("reports an OCR failure without throwing", async () => {
    const { run } = fakeRunner({ tesseract: { exitCode: 1, stderr: "Error opening data file\nFailed loading language 'rus'" } });
    const out = await extractMediaText(png, { enabled: true, run, which: whichOf("tesseract") });
    expect(out).toMatchObject({ status: "failed", kind: "image", engine: "tesseract" });
    if (out.status === "failed") expect(out.error).toContain("Failed loading language");
  });

  it("transcribes WAV directly with whisper-cli and the configured model", async () => {
    const { run, calls } = fakeRunner({ "whisper-cli": { stdout: " Hello there.\n General Kenobi.\n" } });
    const out = await extractMediaText(wav, {
      enabled: true,
      whisperModelPath: model,
      run,
      which: whichOf("whisper-cli", "whisper-cpp"),
      env: {},
    });
    expect(out).toEqual({ status: "ok", kind: "audio", engine: "whisper-cli", text: "Hello there.\nGeneral Kenobi.", truncated: false });
    expect(calls.map((c) => c.command)).toEqual(["whisper-cli"]);
    expect(calls[0]?.args).toEqual(["-m", model, "-f", wav, "-l", "auto", "-nt", "-np"]);
  });

  it("falls back to the Homebrew whisper-cpp name and reads the model from the env", async () => {
    const { run, calls } = fakeRunner({ "whisper-cpp": { stdout: "hi" } });
    const out = await extractMediaText(wav, {
      enabled: true,
      run,
      which: whichOf("whisper-cpp"),
      env: { ATOMIC_AGENT_WHISPER_MODEL: model },
    });
    expect(out).toMatchObject({ status: "ok", engine: "whisper-cpp", text: "hi" });
    expect(calls[0]?.args.slice(0, 2)).toEqual(["-m", model]);
  });

  it("converts non-WAV audio with ffmpeg first and cleans up the temp file", async () => {
    const { run, calls } = fakeRunner({ "whisper-cli": { stdout: "ok" } });
    const out = await extractMediaText(mp3, {
      enabled: true,
      whisperModelPath: model,
      transcriptionLanguage: "ru",
      run,
      which: whichOf("whisper-cli", "ffmpeg"),
      env: {},
    });
    expect(out).toMatchObject({ status: "ok", text: "ok" });
    expect(calls.map((c) => c.command)).toEqual(["ffmpeg", "whisper-cli"]);
    const ffmpegArgs = calls[0]?.args ?? [];
    expect(ffmpegArgs).toContain(mp3);
    expect(ffmpegArgs).toEqual(expect.arrayContaining(["-ar", "16000", "-ac", "1"]));
    const wavOut = ffmpegArgs[ffmpegArgs.length - 1];
    const whisperArgs = calls[1]?.args ?? [];
    expect(whisperArgs[whisperArgs.indexOf("-f") + 1]).toBe(wavOut);
    expect(whisperArgs[whisperArgs.indexOf("-l") + 1]).toBe("ru");
  });

  it("skips non-WAV audio when ffmpeg is missing", async () => {
    const { run, calls } = fakeRunner({});
    const out = await extractMediaText(mp3, { enabled: true, whisperModelPath: model, run, which: whichOf("whisper-cli"), env: {} });
    expect(out).toMatchObject({ status: "skipped", reason: "needs-ffmpeg" });
    expect(calls).toHaveLength(0);
  });

  it("skips audio when no model is configured or the file is missing, never downloading one", async () => {
    const { run, calls } = fakeRunner({});
    const none = await extractMediaText(wav, { enabled: true, run, which: whichOf("whisper-cli"), env: {} });
    expect(none).toMatchObject({ status: "skipped", reason: "no-model" });
    const missing = await extractMediaText(wav, {
      enabled: true,
      whisperModelPath: join(dir, "absent.bin"),
      run,
      which: whichOf("whisper-cli"),
      env: {},
    });
    expect(missing).toMatchObject({ status: "skipped", reason: "no-model" });
    expect(calls).toHaveLength(0);
  });

  it("never uses the Python `whisper` command", async () => {
    const out = await extractMediaText(wav, { enabled: true, whisperModelPath: model, which: whichOf("whisper"), env: {} });
    expect(out).toMatchObject({ status: "skipped", reason: "no-engine" });
  });

  it("reports a failed ffmpeg conversion", async () => {
    const { run, calls } = fakeRunner({ ffmpeg: { exitCode: 1, stderr: "Invalid data found" } });
    const out = await extractMediaText(mp3, { enabled: true, whisperModelPath: model, run, which: whichOf("whisper-cli", "ffmpeg"), env: {} });
    expect(out).toMatchObject({ status: "failed", engine: "ffmpeg" });
    expect(calls.map((c) => c.command)).toEqual(["ffmpeg"]);
  });

  it("reports a timeout", async () => {
    const { run } = fakeRunner({ tesseract: { exitCode: null, timedOut: true, durationMs: 5 } });
    const out = await extractMediaText(png, { enabled: true, timeoutMs: 5, run, which: whichOf("tesseract") });
    expect(out).toMatchObject({ status: "failed" });
    if (out.status === "failed") expect(out.error).toContain("timed out");
  });

  it("passes the time and output limits to the runner", async () => {
    const { run, calls } = fakeRunner({ tesseract: { stdout: "a", truncated: true } });
    const out = await extractMediaText(png, { enabled: true, timeoutMs: 1234, maxOutputBytes: 99, run, which: whichOf("tesseract") });
    expect(out).toMatchObject({ status: "ok", truncated: true });
    expect(calls[0]?.options).toMatchObject({ timeoutMs: 1234, maxOutputBytes: 99 });
  });
});

describe("probeMediaTextEngines", () => {
  it("lists what the machine has", async () => {
    const engines = await probeMediaTextEngines({ which: whichOf("tesseract", "whisper-cpp", "ffmpeg"), whisperModelPath: model });
    expect(engines).toEqual({ ocr: "tesseract", transcription: "whisper-cpp", whisperModel: model, ffmpeg: true });
    const bare = await probeMediaTextEngines({ which: whichOf(), env: {} });
    expect(bare).toEqual({ ocr: null, transcription: null, whisperModel: null, ffmpeg: false });
  });
});

describe("normaliseText", () => {
  it("trims lines, collapses blank runs and form feeds", () => {
    expect(normaliseText("\r\n a \r\n\r\n\r\n\r\n b\f\f c ")).toBe("a\n\nb\n\nc");
  });
});
