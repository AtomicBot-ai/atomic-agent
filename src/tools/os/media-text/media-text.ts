import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";

import { VisionUnsupportedError, type LlmProvider } from "../../../llm/index.js";
import { downloadFile } from "../../../local-llm/downloads/download-file.js";
import { runProcess, type RunProcess } from "../../audio/run-process.js";
import { cleanTranscript, ffmpegToWavArgs, isAudioPath, readableWithoutFfmpeg, whisperCliArgs } from "../../audio/whisper-args.js";
import { resolveFfmpegBinary, resolveWhisperBinary, type BinaryLookupOptions } from "../../audio/whisper-binary.js";
import {
  DEFAULT_WHISPER_MODEL,
  formatModelSize,
  resolveWhisperModel,
  type ModelLookupOptions,
} from "../../audio/whisper-models.js";
import { loadImageFile } from "../../vision/load-image.js";

/**
 * Text out of photos and audio, for the file index (ATO-1051, epic ATO-980).
 *
 * The index itself (ATO-340) is not built yet, so this module is the
 * pluggable step it will call per file: given a path, answer the text a
 * photo shows or an audio file says, or say why it was skipped.
 *
 * - Photos go to the vision model the agent already uses for
 *   `vision.describe` (`LlmProvider.describeImage`), asked to copy out
 *   the visible text, or describe the picture when there is none. No
 *   separate OCR engine.
 * - Audio goes through whisper.cpp with the shared pieces of
 *   `audio.transcribe` (`src/tools/audio/`, ATO-702): the same binary and
 *   ffmpeg lookup, the same argv, and the same speech models under
 *   `<localModelsDataDir>/whisper/` (default `base`). A model that is not
 *   on disk yet is fetched from the same URL into the same place, but
 *   only when the caller passes `allowModelDownload: true`; otherwise the
 *   answer is `skipped: needs-model-download` with the size, so the index
 *   can ask the user once.
 *
 * Both cost real compute, so nothing runs unless the caller passes
 * `enabled: true`; the default answer is `skipped: disabled`. A missing
 * vision model, whisper binary or ffmpeg is a skip, not an error, so an
 * index walk keeps going.
 */

export type MediaKind = "image" | "audio";

/** The formats `vision.describe` loads (`loadImageFile`). */
export const IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

/** Which media kind a path is, by extension; `null` for anything else. */
export function mediaKindForPath(path: string): MediaKind | null {
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (isAudioPath(path)) return "audio";
  return null;
}

export type MediaSkipReason =
  /** The caller did not turn media extraction on. */
  | "disabled"
  /** Not an image or audio extension this module handles. */
  | "unsupported"
  /** Larger than `maxBytes`. */
  | "too-large"
  /** No provider passed, or the model serving it cannot read images. */
  | "no-vision-model"
  /** No whisper.cpp binary found. */
  | "no-engine"
  /** The speech model is not on disk and `allowModelDownload` is off. */
  | "needs-model-download"
  /** No speech model can be resolved (bad env path, no models folder given). */
  | "no-model"
  /** Non-WAV audio and no ffmpeg to convert it. */
  | "needs-ffmpeg";

export type MediaTextResult =
  | { status: "ok"; kind: MediaKind; engine: string; text: string }
  | {
      status: "skipped";
      kind: MediaKind | null;
      reason: MediaSkipReason;
      detail?: string;
      /** Set with `needs-model-download`: what would be fetched. */
      download?: { model: string; sizeMb: number; url: string };
    }
  | { status: "failed"; kind: MediaKind; engine: string; error: string };

/** The slice of `LlmProvider` photo text needs. */
export type VisionModel = Pick<LlmProvider, "name" | "capabilities" | "describeImage">;

export interface MediaTextOptions {
  /** Off unless set: vision calls and transcription cost compute. */
  enabled?: boolean;
  /** Skip files bigger than this. Default 200 MB (audio is large). */
  maxBytes?: number;
  signal?: AbortSignal;

  /** The provider `vision.describe` would use; photos are skipped without one. */
  vision?: VisionModel | (() => VisionModel | undefined);
  /** Per-image cap mirrored from `config.vision.maxImageBytes`. Default 20 MB. */
  maxImageBytes?: number;

  /** `config.paths.localModelsDataDir`; speech models live in `<it>/whisper`. */
  localModelsDataDir?: string;
  /** Speech model id from the `audio.transcribe` catalog. Default `base`. */
  whisperModel?: string;
  /** Fetch the speech model when it is not on disk yet. Default off. */
  allowModelDownload?: boolean;
  /** whisper.cpp language code, or `auto` (default). */
  transcriptionLanguage?: string;

  /** Test seams. */
  binaryLookup?: BinaryLookupOptions;
  modelLookup?: ModelLookupOptions;
  run?: RunProcess;
  download?: (url: string, dest: string, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const CONVERT_TIMEOUT_MS = 5 * 60_000;
const TRANSCRIBE_TIMEOUT_MS = 30 * 60_000;

/** What the vision model is asked for each photo. */
export const IMAGE_TEXT_PROMPT =
  "Copy out all text visible in this image exactly as written, keeping line breaks and the original language. " +
  "Do not translate or comment. If the image has no text, describe what it shows in one or two sentences.";

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
  return kind === "image" ? imageText(path, options) : transcribeAudio(path, options);
}

async function imageText(path: string, options: MediaTextOptions): Promise<MediaTextResult> {
  const vision = typeof options.vision === "function" ? options.vision() : options.vision;
  if (vision === undefined) {
    return { status: "skipped", kind: "image", reason: "no-vision-model", detail: "no vision provider configured" };
  }
  if (!vision.capabilities.vision) {
    return { status: "skipped", kind: "image", reason: "no-vision-model", detail: `${vision.name} cannot read images` };
  }
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  let image;
  try {
    image = await loadImageFile(path, dirname(path), { maxBytes: maxImageBytes });
  } catch (err) {
    return { status: "failed", kind: "image", engine: vision.name, error: (err as Error).message };
  }
  try {
    const result = await vision.describeImage({
      prompt: IMAGE_TEXT_PROMPT,
      images: [{ id: 1, bytes: image.bytes, mimeType: image.mimeType }],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { status: "ok", kind: "image", engine: vision.name, text: result.text.trim() };
  } catch (err) {
    if (err instanceof VisionUnsupportedError) {
      return { status: "skipped", kind: "image", reason: "no-vision-model", detail: err.message };
    }
    return { status: "failed", kind: "image", engine: vision.name, error: (err as Error).message };
  }
}

async function transcribeAudio(path: string, options: MediaTextOptions): Promise<MediaTextResult> {
  const whisper = resolveWhisperBinary(options.binaryLookup);
  if (!whisper.found) return { status: "skipped", kind: "audio", reason: "no-engine", detail: whisper.reason };

  if (options.localModelsDataDir === undefined) {
    return { status: "skipped", kind: "audio", reason: "no-model", detail: "no local models folder given" };
  }
  const model = resolveWhisperModel(
    options.localModelsDataDir,
    options.whisperModel ?? DEFAULT_WHISPER_MODEL,
    options.modelLookup,
  );
  if (model.kind === "error") return { status: "skipped", kind: "audio", reason: "no-model", detail: model.reason };

  const signal = options.signal ?? new AbortController().signal;
  let modelPath: string;
  if (model.kind === "download") {
    const offer = { model: model.model.id, sizeMb: model.model.sizeMb, url: model.url };
    if (options.allowModelDownload !== true) {
      return {
        status: "skipped",
        kind: "audio",
        reason: "needs-model-download",
        detail: `speech model "${model.model.id}" (${formatModelSize(model.model.sizeMb)}) is not downloaded yet`,
        download: offer,
      };
    }
    try {
      await mkdir(dirname(model.path), { recursive: true });
      await (options.download ?? defaultDownload)(model.url, model.path, signal);
    } catch (err) {
      return { status: "failed", kind: "audio", engine: "download", error: (err as Error).message };
    }
    modelPath = model.path;
  } else {
    modelPath = model.path;
  }

  const ffmpeg = resolveFfmpegBinary(options.binaryLookup);
  if (!ffmpeg.found && !readableWithoutFfmpeg(path)) {
    return { status: "skipped", kind: "audio", reason: "needs-ffmpeg", detail: ffmpeg.reason };
  }

  const run = options.run ?? runProcess;
  let workDir: string | null = null;
  try {
    let wav = path;
    if (ffmpeg.found) {
      workDir = await mkdtemp(join(tmpdir(), "atomic-media-text-"));
      wav = join(workDir, "audio.wav");
      const conv = await run(ffmpeg.path, ffmpegToWavArgs(path, wav), { signal, timeoutMs: CONVERT_TIMEOUT_MS });
      if (conv.code !== 0) {
        return { status: "failed", kind: "audio", engine: "ffmpeg", error: tail(conv.stderr || conv.error || "unknown error") };
      }
    }
    const res = await run(
      whisper.path,
      whisperCliArgs({ model: modelPath, wav, language: options.transcriptionLanguage ?? "auto" }),
      { signal, timeoutMs: TRANSCRIBE_TIMEOUT_MS },
    );
    if (res.code !== 0) {
      return { status: "failed", kind: "audio", engine: "whisper.cpp", error: tail(res.stderr || res.error || "unknown error") };
    }
    return { status: "ok", kind: "audio", engine: "whisper.cpp", text: cleanTranscript(res.stdout) };
  } finally {
    if (workDir !== null) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const defaultDownload = (url: string, dest: string, signal: AbortSignal) => downloadFile(url, dest, { signal });

function tail(text: string, max = 600): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}
