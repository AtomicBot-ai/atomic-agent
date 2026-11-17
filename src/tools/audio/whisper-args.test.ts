import { describe, expect, it } from "vitest";
import {
  cleanTranscript,
  ffmpegToWavArgs,
  isAudioPath,
  normalizeLanguage,
  readableWithoutFfmpeg,
  whisperCliArgs,
} from "./whisper-args.js";

describe("audio.transcribe command lines (ATO-702)", () => {
  it("converts any input to 16 kHz mono 16-bit WAV, dropping video", () => {
    expect(ffmpegToWavArgs("/in/voice.ogg", "/tmp/x/audio.wav")).toEqual([
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", "/in/voice.ogg",
      "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      "/tmp/x/audio.wav",
    ]);
  });

  it("asks whisper.cpp for plain text without timestamps or progress", () => {
    expect(whisperCliArgs({ model: "/m/ggml-base.bin", wav: "/t/a.wav", language: "auto" })).toEqual([
      "-m", "/m/ggml-base.bin", "-f", "/t/a.wav", "-l", "auto", "-nt", "-np",
    ]);
    expect(whisperCliArgs({ model: "m", wav: "w", language: "ru", threads: 4, translate: true })).toEqual([
      "-m", "m", "-f", "w", "-l", "ru", "-t", "4", "-tr", "-nt", "-np",
    ]);
  });

  it("keeps a file name with spaces as one argument", () => {
    const args = ffmpegToWavArgs("/in/my voice; rm -rf.ogg", "/t/a.wav");
    expect(args).toContain("/in/my voice; rm -rf.ogg");
  });

  it("accepts only ISO-like language codes", () => {
    expect(normalizeLanguage(undefined)).toBe("auto");
    expect(normalizeLanguage(" RU ")).toBe("ru");
    expect(normalizeLanguage("pt-br")).toBe("pt-br");
    expect(normalizeLanguage("--model x")).toBeNull();
    expect(normalizeLanguage(3)).toBeNull();
  });

  it("knows audio extensions and which need ffmpeg", () => {
    expect(isAudioPath("/a/voice.OGG")).toBe(true);
    expect(isAudioPath("/a/doc.pdf")).toBe(false);
    expect(readableWithoutFfmpeg("/a/x.wav")).toBe(true);
    expect(readableWithoutFfmpeg("/a/x.ogg")).toBe(false);
  });

  it("joins whisper's segment lines into clean text", () => {
    expect(cleanTranscript(" Hello there.\r\n\n And again.\n")).toBe("Hello there.\nAnd again.");
  });
});
