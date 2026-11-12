import { open, stat } from "node:fs/promises";

import type { AudioInputFormat } from "../../llm/index.js";
import { resolveUserPath } from "../os/expand-home.js";

/** Bytes `sniffAudioFormat` needs to tell WAV and MP3 apart. */
export const AUDIO_SNIFF_PREFIX_BYTES = 12;

/**
 * The audio format the bytes carry, among the two an OpenAI-compatible
 * `input_audio` part accepts; `null` for anything else (Telegram's
 * `.ogg` voice notes, m4a, flac), which stays on the transcription path.
 *
 * - WAV: `RIFF` at 0 and `WAVE` at 8.
 * - MP3: an `ID3` tag, or an MPEG audio Layer III frame sync
 *   (`0xFF`, then 3 more sync bits, a version that is not the reserved
 *   one and layer bits `01`). AAC's ADTS sync has layer bits `00` and is
 *   not MP3.
 */
export function sniffAudioFormat(bytes: Uint8Array): AudioInputFormat | null {
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WAVE"
  ) {
    return "wav";
  }
  if (bytes.length >= 3 && ascii(bytes, 0, 3) === "ID3") return "mp3";
  if (bytes.length >= 2 && bytes[0] === 0xff) {
    const b1 = bytes[1]!;
    const sync = (b1 & 0xe0) === 0xe0;
    const version = (b1 >> 3) & 0x03;
    const layer = (b1 >> 1) & 0x03;
    if (sync && version !== 0x01 && layer === 0x01) return "mp3";
  }
  return null;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

export interface LoadedAudio {
  /** Absolute path the bytes came from. */
  path: string;
  bytes: Uint8Array;
  format: AudioInputFormat;
}

/** The file is not WAV or MP3 by its bytes. */
export class UnsupportedAudioFormatError extends Error {
  constructor(path: string) {
    super(
      `unsupported audio ${path}: only WAV and MP3 can go to the model directly` +
        " — for other formats (ogg voice notes, m4a, flac) use the audio-transcribe skill",
    );
    this.name = "UnsupportedAudioFormatError";
  }
}

export class AudioTooLargeError extends Error {
  constructor(path: string, size: number, maxBytes: number) {
    super(
      `audio ${path} exceeds vision.maxAudioBytes=${maxBytes} (${size} bytes on disk)` +
        " — use the audio-transcribe skill for long recordings",
    );
    this.name = "AudioTooLargeError";
  }
}

export class NotARegularAudioFileError extends Error {
  constructor(path: string) {
    super(`${path} is not a regular file — audio.listen reads audio files on disk`);
    this.name = "NotARegularAudioFileError";
  }
}

/**
 * Read a WAV or MP3 file (tilde + relative-to-`workingDir` paths, like
 * the OS tools). The `stat` comes first so a device, a pipe or a file
 * past `maxBytes` is refused without being read; the format is decided
 * by the bytes, never the extension, since channel attachments keep the
 * client's filename.
 */
export async function loadAudioFile(
  inputPath: string,
  workingDir: string,
  maxBytes: number,
): Promise<LoadedAudio> {
  const absolute = resolveUserPath(inputPath, workingDir);
  const stats = await stat(absolute);
  if (!stats.isFile()) throw new NotARegularAudioFileError(absolute);
  if (stats.size > maxBytes) {
    throw new AudioTooLargeError(absolute, stats.size, maxBytes);
  }
  const handle = await open(absolute, "r");
  let bytes: Uint8Array;
  try {
    const buffer = await handle.readFile();
    bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } finally {
    await handle.close();
  }
  // The file may have grown between the stat and the read.
  if (bytes.byteLength > maxBytes) {
    throw new AudioTooLargeError(absolute, bytes.byteLength, maxBytes);
  }
  const format = sniffAudioFormat(bytes.subarray(0, AUDIO_SNIFF_PREFIX_BYTES));
  if (format === null) throw new UnsupportedAudioFormatError(absolute);
  return { path: absolute, bytes, format };
}
