import { extname } from "node:path";

/**
 * The two command lines `audio.transcribe` runs (ATO-702), kept pure so
 * they are pinned by tests without spawning anything.
 *
 * whisper.cpp reads 16-bit PCM WAV at 16 kHz. A Telegram voice note is
 * OGG/Opus, which it cannot read at all, and other formats only in some
 * builds; so every input goes through ffmpeg first when ffmpeg is there.
 * Without ffmpeg only a `.wav` is tried as is.
 */

/** Sample rate whisper.cpp expects. */
export const WHISPER_SAMPLE_RATE = 16_000;

/** Extensions the tool takes; anything else is refused before spawning. */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  ".wav", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".webm", ".mp4", ".mov", ".mkv", ".wma", ".amr",
]);

export function isAudioPath(path: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(path).toLowerCase());
}

/** True when whisper.cpp may read the file without ffmpeg. */
export function readableWithoutFfmpeg(path: string): boolean {
  return extname(path).toLowerCase() === ".wav";
}

/** `ffmpeg … -i <input> -ar 16000 -ac 1 -c:a pcm_s16le <output>`: mono 16 kHz WAV, video dropped. */
export function ffmpegToWavArgs(input: string, output: string): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    "-y",
    "-i", input,
    "-vn",
    "-ar", String(WHISPER_SAMPLE_RATE),
    "-ac", "1",
    "-c:a", "pcm_s16le",
    output,
  ];
}

export interface WhisperRunArgs {
  model: string;
  wav: string;
  /** ISO code (`en`, `ru`) or `auto`. */
  language: string;
  threads?: number;
  /** Ask whisper.cpp to translate the speech into English. */
  translate?: boolean;
}

/**
 * `whisper-cli -m <model> -f <wav> -l <lang> -nt -np`: plain text on
 * stdout, no timestamps, no progress or system info.
 */
export function whisperCliArgs(run: WhisperRunArgs): string[] {
  return [
    "-m", run.model,
    "-f", run.wav,
    "-l", run.language,
    ...(run.threads !== undefined ? ["-t", String(run.threads)] : []),
    ...(run.translate === true ? ["-tr"] : []),
    "-nt",
    "-np",
  ];
}

/** `ru`, `en`, `auto`, … The value goes to argv, so only letters and a dash. */
export function normalizeLanguage(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return "auto";
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return /^(auto|[a-z]{2,3}(-[a-z]{2,4})?)$/.test(value) ? value : null;
}

/**
 * whisper.cpp prints one line per segment, sometimes with a leading
 * space and blank lines between. Joined into one paragraph-per-line text.
 */
export function cleanTranscript(stdout: string): string {
  return stdout
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}
