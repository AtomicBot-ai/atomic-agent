import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

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
  /** Download size in MB, for the approval text. */
  sizeMb: number;
  /** Exact size and SHA-256 the repository lists (Hugging Face LFS), checked after download. */
  sizeBytes: number;
  sha256: string;
  note: string;
}

export const WHISPER_MODELS: readonly WhisperModel[] = [
  { id: "tiny", file: "ggml-tiny.bin", sizeMb: 78, sizeBytes: 77_691_713, sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21", note: "fastest, rough on accents" },
  { id: "base", file: "ggml-base.bin", sizeMb: 148, sizeBytes: 147_951_465, sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe", note: "fast, good for clear speech" },
  { id: "small", file: "ggml-small.bin", sizeMb: 488, sizeBytes: 487_601_967, sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b", note: "slower, noticeably better on non-English speech" },
  { id: "medium", file: "ggml-medium.bin", sizeMb: 1534, sizeBytes: 1_533_763_059, sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208", note: "slow, high accuracy" },
  { id: "large-v3-turbo", file: "ggml-large-v3-turbo.bin", sizeMb: 1625, sizeBytes: 1_624_555_275, sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69", note: "best accuracy, needs a fast machine" },
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

/** `<models dir>/whisper/settings.json`: the model the user picked as default. */
export function whisperSettingsPath(localModelsDataDir: string): string {
  return join(whisperModelsDir(localModelsDataDir), "settings.json");
}

/** The persisted default model id, or the built-in `base` when none or unknown. */
export function readDefaultWhisperModel(localModelsDataDir: string): string {
  try {
    const raw = JSON.parse(readFileSync(whisperSettingsPath(localModelsDataDir), "utf8")) as { defaultModel?: unknown };
    if (typeof raw.defaultModel === "string" && whisperModelById(raw.defaultModel)) return raw.defaultModel;
  } catch {
    /* no settings yet */
  }
  return DEFAULT_WHISPER_MODEL;
}

/** Persist `id` as the default (atomic write). Throws on an unknown id. */
export function writeDefaultWhisperModel(localModelsDataDir: string, id: string): void {
  const model = whisperModelById(id);
  if (!model) throw new Error(`unknown whisper model "${id}"; use one of ${WHISPER_MODELS.map((m) => m.id).join(", ")}`);
  const path = whisperSettingsPath(localModelsDataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ defaultModel: model.id }, null, 2)}\n`);
  renameSync(tmp, path);
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
  /** Test seam: the persisted default; default reads `settings.json`. */
  defaultModel?: (localModelsDataDir: string) => string;
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
 * (and no `requested` id overrides it), else the requested catalog id,
 * else the persisted default (`settings.json`, built-in `base`),
 * downloaded or not.
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
  const id = requested ?? (options.defaultModel ?? readDefaultWhisperModel)(localModelsDataDir);
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
