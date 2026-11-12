import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * The ggml speech models whisper.cpp runs (ATO-702), from the official
 * `ggerganov/whisper.cpp` repository on Hugging Face. A model is
 * downloaded on demand into `<models dir>/whisper/` and only after the
 * user agreed (the tool asks with the size in the approval).
 *
 * All multilingual: a Telegram voice message is as likely Russian as
 * English, and the `.en` variants only hear English.
 */

/** Points at a ggml model file; wins over the catalog. */
export const WHISPER_MODEL_ENV = "ATOMIC_AGENT_WHISPER_MODEL";

export interface WhisperModel {
  id: string;
  file: string;
  /** Download size in MB as the repository lists it, for the approval text. */
  sizeMb: number;
  note: string;
}

export const WHISPER_MODELS: readonly WhisperModel[] = [
  { id: "tiny", file: "ggml-tiny.bin", sizeMb: 75, note: "fastest, rough on accents" },
  { id: "base", file: "ggml-base.bin", sizeMb: 142, note: "fast, good for clear speech" },
  { id: "small", file: "ggml-small.bin", sizeMb: 466, note: "slower, noticeably better on non-English speech" },
  { id: "medium", file: "ggml-medium.bin", sizeMb: 1530, note: "slow, high accuracy" },
  { id: "large-v3-turbo", file: "ggml-large-v3-turbo.bin", sizeMb: 1620, note: "best accuracy, needs a fast machine" },
];

/** Small enough to fetch without a long wait, multilingual. */
export const DEFAULT_WHISPER_MODEL = "base";

const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export function whisperModelById(id: string): WhisperModel | undefined {
  return WHISPER_MODELS.find((m) => m.id === id.trim().toLowerCase());
}

export function whisperModelUrl(model: WhisperModel): string {
  return `${HF_BASE}/${model.file}`;
}

/** `<models dir>/whisper`: next to the chat models, inside the state folder. */
export function whisperModelsDir(localModelsDataDir: string): string {
  return join(localModelsDataDir, "whisper");
}

export function whisperModelPath(localModelsDataDir: string, model: WhisperModel): string {
  return join(whisperModelsDir(localModelsDataDir), model.file);
}

export type ModelResolution =
  /** A file on disk, ready to run. */
  | { kind: "ready"; path: string; label: string }
  /** A catalog model that is not downloaded yet. */
  | { kind: "download"; model: WhisperModel; path: string; url: string }
  | { kind: "error"; reason: string };

export interface ModelLookupOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam: true when a non-empty file is at `path`. */
  fileExists?: (path: string) => boolean;
}

function defaultFileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

/**
 * Which model file a call runs: `ATOMIC_AGENT_WHISPER_MODEL` when set
 * (and no `requested` id overrides it), else the requested catalog id
 * (default `base`), downloaded or not.
 */
export function resolveWhisperModel(
  localModelsDataDir: string,
  requested: string | undefined,
  options: ModelLookupOptions = {},
): ModelResolution {
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? defaultFileExists;
  const configured = env[WHISPER_MODEL_ENV]?.trim();
  if (configured && requested === undefined) {
    if (!isAbsolute(configured)) {
      return { kind: "error", reason: `${WHISPER_MODEL_ENV} must be an absolute path (got "${configured}")` };
    }
    if (!fileExists(configured)) {
      return { kind: "error", reason: `${WHISPER_MODEL_ENV} points at ${configured}, which is not a model file` };
    }
    return { kind: "ready", path: configured, label: configured };
  }
  const id = requested ?? DEFAULT_WHISPER_MODEL;
  const model = whisperModelById(id);
  if (!model) {
    return {
      kind: "error",
      reason: `unknown whisper model "${id}"; use one of ${WHISPER_MODELS.map((m) => m.id).join(", ")}`,
    };
  }
  const path = whisperModelPath(localModelsDataDir, model);
  if (fileExists(path)) return { kind: "ready", path, label: model.id };
  return { kind: "download", model, path, url: whisperModelUrl(model) };
}

/** "142 MB" / "1.5 GB" for the approval and the error text. */
export function formatModelSize(sizeMb: number): string {
  return sizeMb >= 1000 ? `${(sizeMb / 1000).toFixed(1)} GB` : `${sizeMb} MB`;
}
