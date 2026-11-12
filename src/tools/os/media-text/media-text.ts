import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { extname, join } from "node:path";

import { runCommand } from "../../../sandbox/command-runner.js";
import type { CommandOptions, CommandResult } from "../../../sandbox/command-runner.js";

/**
 * Text out of photos and audio, for the file index (ATO-1051, epic ATO-980).
 *
 * The index itself (ATO-340) is not built yet, so this module is the
 * pluggable step it will call per file: given a path, answer the text a
 * photo shows (OCR) or an audio file says (transcription), or say why it
 * was skipped. It never downloads anything and adds no dependency:
 *
 * - OCR uses the `tesseract` binary when it is on PATH.
 * - Transcription uses whisper.cpp's CLI (`whisper-cli`, or the older
 *   Homebrew name `whisper-cpp`) with a ggml model file the user already
 *   has, named by `whisperModelPath` or `ATOMIC_AGENT_WHISPER_MODEL`.
 *   No Python. Audio that is not WAV is converted with `ffmpeg` first,
 *   when `ffmpeg` is on PATH.
 *
 * Both cost real compute (transcription can take minutes per hour of
 * audio), so nothing runs unless the caller passes `enabled: true`; the
 * default answer is `skipped: disabled`. A missing engine or model is a
 * skip, not an error, so an index walk keeps going.
 */

export type MediaKind = "image" | "audio";

/** Extensions tesseract (via leptonica) reads directly. */
export const IMAGE_EXTENSIONS: readonly string[] = [
  ".png",
  ".jpg",
  ".jpeg",
  ".tif",
  ".tiff",
  ".bmp",
  ".gif",
  ".webp",
];

/** Audio we hand to whisper.cpp (WAV directly, the rest through ffmpeg). */
export const AUDIO_EXTENSIONS: readonly string[] = [
  ".wav",
  ".mp3",
  ".m4a",
  ".ogg",
  ".oga",
  ".opus",
  ".flac",
  ".aac",
  ".webm",
];

/** Which media kind a path is, by extension; `null` for anything else. */
export function mediaKindForPath(path: string): MediaKind | null {
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (AUDIO_EXTENSIONS.includes(ext)) return "audio";
  return null;
}

export type MediaSkipReason =
  /** The caller did not turn media extraction on. */
  | "disabled"
  /** Not an image or audio extension this module handles. */
  | "unsupported"
  /** Larger than `maxBytes`. */
  | "too-large"
  /** No OCR / transcription binary on PATH. */
  | "no-engine"
  /** whisper.cpp is there, but no model file is configured or it is missing. */
  | "no-model"
  /** Non-WAV audio and no `ffmpeg` to convert it. */
  | "needs-ffmpeg";

export type MediaTextResult =
  | {
      status: "ok";
      kind: MediaKind;
      engine: string;
      text: string;
      /** The text came out cut at `maxOutputBytes`. */
      truncated: boolean;
    }
  | { status: "skipped"; kind: MediaKind | null; reason: MediaSkipReason; detail?: string }
  | { status: "failed"; kind: MediaKind; engine: string; error: string };

export type CommandRunner = (
  command: string,
  args: string[],
  options: CommandOptions,
) => Promise<CommandResult>;

/** `true` when `bin` resolves on PATH. */
export type BinaryProbe = (bin: string) => Promise<boolean>;

export interface MediaTextOptions {
  /** Off unless set: OCR and transcription cost compute. */
  enabled?: boolean;
  /** Skip files bigger than this. Default 200 MB (audio is large). */
  maxBytes?: number;
  /** Tesseract language list, e.g. `eng+rus`. Default `eng`. */
  ocrLanguages?: string;
  /** whisper.cpp ggml model file. Falls back to `ATOMIC_AGENT_WHISPER_MODEL`. */
  whisperModelPath?: string;
  /** whisper.cpp language code, or `auto` (default). */
  transcriptionLanguage?: string;
  /** Per-file time limit. Default 10 minutes. */
  timeoutMs?: number;
  /** Cap on text kept per file. Default 1 MB. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** Test seams. */
  run?: CommandRunner;
  which?: BinaryProbe;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Whisper CLI names, newest first. `whisper` alone is the Python package, so it is not used. */
export const WHISPER_BINARIES: readonly string[] = ["whisper-cli", "whisper-cpp"];

export interface MediaTextEngines {
  ocr: string | null;
  transcription: string | null;
  whisperModel: string | null;
  ffmpeg: boolean;
}

/**
 * What this machine can do right now. Cheap (`which` per binary); an
 * index can call it once per walk and show the user what is missing.
 */
export async function probeMediaTextEngines(
  options: Pick<MediaTextOptions, "whisperModelPath" | "which" | "env"> = {},
): Promise<MediaTextEngines> {
  const which = options.which ?? defaultWhich;
  const [ocr, transcription, ffmpeg] = await Promise.all([
    which("tesseract").then((ok) => (ok ? "tesseract" : null)),
    firstPresent(WHISPER_BINARIES, which),
    which("ffmpeg"),
  ]);
  return { ocr, transcription, whisperModel: resolveWhisperModel(options), ffmpeg };
}

/** Text from one photo or audio file, or the reason it was skipped. */
export async function extractMediaText(
  path: string,
  options: MediaTextOptions = {},
): Promise<MediaTextResult> {
  const kind = mediaKindForPath(path);
  if (kind === null) return { status: "skipped", kind: null, reason: "unsupported" };
  if (options.enabled !== true) return { status: "skipped", kind, reason: "disabled" };

  const size = (await stat(path)).size;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (size > maxBytes) {
    return { status: "skipped", kind, reason: "too-large", detail: `${size} bytes > ${maxBytes}` };
  }

  const engines = await probeMediaTextEngines(options);
  return kind === "image" ? ocrImage(path, engines, options) : transcribeAudio(path, engines, options);
}

async function ocrImage(
  path: string,
  engines: MediaTextEngines,
  options: MediaTextOptions,
): Promise<MediaTextResult> {
  if (engines.ocr === null) {
    return { status: "skipped", kind: "image", reason: "no-engine", detail: "tesseract not found on PATH" };
  }
  const args = [path, "stdout", "-l", options.ocrLanguages ?? "eng"];
  return runEngine("image", engines.ocr, args, options);
}

async function transcribeAudio(
  path: string,
  engines: MediaTextEngines,
  options: MediaTextOptions,
): Promise<MediaTextResult> {
  if (engines.transcription === null) {
    return {
      status: "skipped",
      kind: "audio",
      reason: "no-engine",
      detail: `none of ${WHISPER_BINARIES.join(", ")} found on PATH`,
    };
  }
  const model = engines.whisperModel;
  if (model === null) {
    return {
      status: "skipped",
      kind: "audio",
      reason: "no-model",
      detail: "set whisperModelPath or ATOMIC_AGENT_WHISPER_MODEL to an existing ggml model file",
    };
  }
  const isWav = extname(path).toLowerCase() === ".wav";
  if (!isWav && !engines.ffmpeg) {
    return { status: "skipped", kind: "audio", reason: "needs-ffmpeg", detail: "ffmpeg not found on PATH" };
  }

  let scratch: string | null = null;
  try {
    let input = path;
    if (!isWav) {
      scratch = await mkdtemp(join(tmpdir(), "atomic-agent-media-"));
      input = join(scratch, "audio.wav");
      // whisper.cpp wants 16 kHz mono 16-bit PCM.
      const converted = await (options.run ?? runCommand)(
        "ffmpeg",
        ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", input],
        commandOptions(options),
      );
      if (converted.exitCode !== 0) {
        return { status: "failed", kind: "audio", engine: "ffmpeg", error: failureText(converted) };
      }
    }
    const args = [
      "-m",
      model,
      "-f",
      input,
      "-l",
      options.transcriptionLanguage ?? "auto",
      "-nt",
      "-np",
    ];
    return await runEngine("audio", engines.transcription, args, options);
  } finally {
    if (scratch !== null) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runEngine(
  kind: MediaKind,
  engine: string,
  args: string[],
  options: MediaTextOptions,
): Promise<MediaTextResult> {
  let result: CommandResult;
  try {
    result = await (options.run ?? runCommand)(engine, args, commandOptions(options));
  } catch (err) {
    return { status: "failed", kind, engine, error: err instanceof Error ? err.message : String(err) };
  }
  if (result.exitCode !== 0) return { status: "failed", kind, engine, error: failureText(result) };
  return { status: "ok", kind, engine, text: normaliseText(result.stdout), truncated: result.truncated };
}

function commandOptions(options: MediaTextOptions): CommandOptions {
  return {
    cwd: tmpdir(),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    ...(options.env ? { env: options.env } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function failureText(result: CommandResult): string {
  if (result.timedOut) return `timed out after ${result.durationMs} ms`;
  const tail = result.stderr.trim().split("\n").slice(-3).join(" ").trim();
  return `exit ${result.exitCode ?? result.signal ?? "unknown"}${tail ? `: ${tail}` : ""}`;
}

/** Trim each line, drop blank runs, keep paragraph breaks. */
export function normaliseText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function resolveWhisperModel(options: Pick<MediaTextOptions, "whisperModelPath" | "env">): string | null {
  const env = options.env ?? process.env;
  const candidate = options.whisperModelPath ?? env.ATOMIC_AGENT_WHISPER_MODEL;
  if (candidate === undefined || candidate.trim() === "") return null;
  return existsSync(candidate) ? candidate : null;
}

async function firstPresent(bins: readonly string[], which: BinaryProbe): Promise<string | null> {
  for (const bin of bins) {
    if (await which(bin)) return bin;
  }
  return null;
}

async function defaultWhich(bin: string): Promise<boolean> {
  const [tool, args] = platform() === "win32" ? ["where", [bin]] : ["which", [bin]];
  try {
    const result = await runCommand(tool, args, { cwd: tmpdir(), timeoutMs: 2000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
