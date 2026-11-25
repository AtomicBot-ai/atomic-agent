import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AudioTooLargeError,
  loadAudioFile,
  NotARegularAudioFileError,
  sniffAudioFormat,
  UnsupportedAudioFormatError,
} from "./load-audio.js";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

const WAV_HEADER = bytes(...text("RIFF"), 0x24, 0, 0, 0, ...text("WAVE"), ...text("fmt "));
const MP3_ID3 = bytes(...text("ID3"), 4, 0, 0, 0, 0, 0, 0);
/** MPEG-1 Layer III frame sync: 0xFF 0xFB. */
const MP3_FRAME = bytes(0xff, 0xfb, 0x90, 0x64);

describe("sniffAudioFormat (ATO-497)", () => {
  it("knows WAV and MP3 by their bytes", () => {
    expect(sniffAudioFormat(WAV_HEADER)).toBe("wav");
    expect(sniffAudioFormat(MP3_ID3)).toBe("mp3");
    expect(sniffAudioFormat(MP3_FRAME)).toBe("mp3");
  });

  it("refuses what input_audio cannot carry", () => {
    expect(sniffAudioFormat(bytes(...text("OggS"), 0, 2))).toBeNull(); // Telegram voice
    expect(sniffAudioFormat(bytes(0xff, 0xf1, 0x50, 0x80))).toBeNull(); // AAC ADTS
    expect(sniffAudioFormat(bytes(...text("RIFF"), 0, 0, 0, 0, ...text("WEBP")))).toBeNull();
    expect(sniffAudioFormat(bytes())).toBeNull();
  });
});

describe("loadAudioFile", () => {
  async function dir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "audio-load-"));
  }

  it("loads a WAV relative to the working dir, typed by its bytes not its name", async () => {
    const root = await dir();
    await writeFile(join(root, "voice.mp3"), WAV_HEADER);
    const loaded = await loadAudioFile("voice.mp3", root, 1024);
    expect(loaded.format).toBe("wav");
    expect(loaded.path).toBe(join(root, "voice.mp3"));
    expect(loaded.bytes.byteLength).toBe(WAV_HEADER.byteLength);
  });

  it("refuses an ogg voice note, an oversized file and a directory", async () => {
    const root = await dir();
    await writeFile(join(root, "voice.ogg"), bytes(...text("OggS"), 0, 2, 0, 0, 0, 0, 0, 0));
    await expect(loadAudioFile("voice.ogg", root, 1024)).rejects.toBeInstanceOf(
      UnsupportedAudioFormatError,
    );
    await writeFile(join(root, "big.wav"), new Uint8Array(64));
    await expect(loadAudioFile("big.wav", root, 16)).rejects.toBeInstanceOf(AudioTooLargeError);
    await expect(loadAudioFile(".", root, 1024)).rejects.toBeInstanceOf(NotARegularAudioFileError);
  });
});
