/**
 * ATO-1049: voice input on Windows and Linux, through whisper.cpp.
 *
 * macOS keeps Apple's on-device SpeechAnalyzer (speech.ts and
 * native/atomic-speech.swift). Elsewhere the renderer records exactly as it
 * does on a Mac (16 kHz mono s16le chunks over `voice:audio`), main keeps
 * the take in memory, and on stop writes it once as a WAV into a private
 * temp folder, runs the user's `whisper-cli` on it and deletes the folder.
 * whisper.cpp has no live partials, so the text arrives as one `final`
 * after the take ends.
 *
 * Same resolution rules as the agent's `audio.transcribe` tool
 * (src/tools/audio/ in the agent, ATO-702), duplicated here in small
 * because the desktop build cannot import from the agent's src:
 *   - binary: `ATOMIC_AGENT_WHISPER_BIN` (absolute), else the copy the
 *     agent downloaded into `<models dir>/whisper/bin/<tag>/`, else
 *     `whisper-cli` / `whisper-cpp` on PATH plus the installer folders a GUI
 *     app misses;
 *   - model: `ATOMIC_AGENT_WHISPER_MODEL` (absolute), else the default
 *     saved in `<models dir>/whisper/settings.json` when its file is there,
 *     else the first ggml model present in `<models dir>/whisper/`.
 * Nothing is downloaded from here: the first-use download (decision 75) is
 * the agent's `atomic-agent whisper install`, which speech.ts runs.
 *
 * Pure apart from the default `isFile` / `isExecutable` probes, and free of
 * electron, so test/whisper-dictation.test.mjs runs it against the build.
 */
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, posix, win32 } from "node:path";
import { withInstallerBinDirs } from "./installer-path.js";

export const WHISPER_BIN_ENV = "ATOMIC_AGENT_WHISPER_BIN";
export const WHISPER_MODEL_ENV = "ATOMIC_AGENT_WHISPER_MODEL";
/** Not `whisper`: that name is the Python openai-whisper CLI. */
export const WHISPER_BINARY_NAMES: readonly string[] = ["whisper-cli", "whisper-cpp"];
/** In the order a dictation would rather have them: fast first. */
export const WHISPER_MODEL_FILES: readonly string[] = [
  "ggml-base.bin",
  "ggml-small.bin",
  "ggml-tiny.bin",
  "ggml-large-v3-turbo.bin",
  "ggml-medium.bin",
];
export const WHISPER_SAMPLE_RATE = 16_000;
/** The speech models the agent's catalogue knows (src/tools/audio/whisper-models.ts). */
export const WHISPER_MODEL_IDS: readonly string[] = ["tiny", "base", "small", "medium", "large-v3-turbo"];
/**
 * The whisper.cpp build the agent pins (src/tools/audio/whisper-release.ts);
 * keep in step. Upstream ships it prebuilt for these only, no macOS CLI.
 */
export const WHISPER_RELEASE_TAG = "b5454";
const DOWNLOADABLE = new Set(["win32-x64", "win32-arm64", "linux-x64", "linux-arm64"]);

/** True where the agent can download whisper.cpp itself. */
export function whisperDownloadable(platform: NodeJS.Platform, arch: string): boolean {
  return DOWNLOADABLE.has(`${platform}-${arch}`);
}

/** `<models dir>/whisper/bin/<tag>/whisper-cli(.exe)`: where the agent unpacks its download. */
export function managedWhisperBinary(modelsDataDir: string, platform: NodeJS.Platform): string {
  return join(modelsDataDir, "whisper", "bin", WHISPER_RELEASE_TAG, platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
}

/** The default the user saved in `settings.json` (the agent writes it), or null. */
export function savedWhisperModel(modelsDataDir: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(modelsDataDir, "whisper", "settings.json"), "utf8")) as { defaultModel?: unknown };
    if (typeof raw.defaultModel === "string" && WHISPER_MODEL_IDS.includes(raw.defaultModel)) return raw.defaultModel;
  } catch {
    /* none saved */
  }
  return null;
}

/**
 * The languages the menu offers. whisper.cpp's multilingual models hear all
 * of them with one file, so every one counts as installed.
 */
export const WHISPER_LOCALES: readonly string[] = [
  "en-US", "ru-RU", "uk-UA", "de-DE", "fr-FR", "es-ES", "it-IT", "pt-BR",
  "pl-PL", "nl-NL", "tr-TR", "zh-CN", "ja-JP", "ko-KR", "hi-IN", "ar-SA",
];

export interface LookupEnv {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
  isExecutable?: (path: string) => boolean;
  isFile?: (path: string) => boolean;
}

export type Found = { found: true; path: string } | { found: false; detail: string };

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultIsFile(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function absolute(value: string | undefined, platform: NodeJS.Platform): string | null {
  const v = value?.trim();
  if (!v) return null;
  const abs = platform === "win32" ? win32.isAbsolute(v) : posix.isAbsolute(v) || isAbsolute(v);
  return abs ? v : null;
}

/** The PATH entries searched: the process PATH, then the installer folders. */
export function searchDirs(o: LookupEnv): string[] {
  const raw = o.env.PATH ?? o.env.Path ?? "";
  if (o.platform === "win32") return raw.split(";").filter(Boolean);
  const widened = withInstallerBinDirs(raw, o.platform, o.home) ?? raw;
  const dirs = widened.split(":").filter(Boolean);
  if (o.platform === "linux" && !dirs.includes("/home/linuxbrew/.linuxbrew/bin")) dirs.push("/home/linuxbrew/.linuxbrew/bin");
  return dirs;
}

export function resolveWhisperBinary(o: LookupEnv, managed?: string): Found {
  const isExecutable = o.isExecutable ?? defaultIsExecutable;
  const configured = absolute(o.env[WHISPER_BIN_ENV], o.platform);
  if (configured) {
    return isExecutable(configured) ? { found: true, path: configured } : { found: false, detail: `${WHISPER_BIN_ENV}: ${configured}` };
  }
  if (managed !== undefined && isExecutable(managed)) return { found: true, path: managed };
  const exts = o.platform === "win32"
    ? ["", ...(o.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)]
    : [""];
  const joinFor = o.platform === "win32" ? win32.join : posix.join;
  for (const name of WHISPER_BINARY_NAMES) {
    for (const dir of searchDirs(o)) {
      for (const ext of exts) {
        const candidate = joinFor(dir, name + ext);
        if (isExecutable(candidate)) return { found: true, path: candidate };
      }
    }
  }
  return { found: false, detail: "whisper-cli not on PATH" };
}

/** `<models dir>/whisper`, where the agent's audio.transcribe keeps its models. */
export function whisperModelsDir(modelsDataDir: string): string {
  return join(modelsDataDir, "whisper");
}

export function resolveWhisperModel(modelsDataDir: string, o: LookupEnv): Found {
  const isFile = o.isFile ?? defaultIsFile;
  const configured = absolute(o.env[WHISPER_MODEL_ENV], o.platform);
  if (configured) {
    return isFile(configured) ? { found: true, path: configured } : { found: false, detail: `${WHISPER_MODEL_ENV}: ${configured}` };
  }
  const dir = whisperModelsDir(modelsDataDir);
  // A saved choice is kept to: with `small` saved and only `base` on disk
  // the model counts as missing, so the download fetches `small`.
  const saved = savedWhisperModel(modelsDataDir);
  if (saved !== null) {
    const path = join(dir, `ggml-${saved}.bin`);
    return isFile(path) ? { found: true, path } : { found: false, detail: path };
  }
  for (const file of WHISPER_MODEL_FILES) {
    const path = join(dir, file);
    if (isFile(path)) return { found: true, path };
  }
  return { found: false, detail: dir };
}

/**
 * The language whisper is told. One chosen locale → its language
 * (`ru-RU` → `ru`); two (the menu's "also listen for") → `auto`, because
 * whisper.cpp hears one language per run and detects it well.
 */
export function whisperLanguage(locales: readonly string[]): string {
  if (locales.length !== 1) return "auto";
  const lang = String(locales[0] ?? "").split(/[-_]/)[0]?.toLowerCase() ?? "";
  return /^[a-z]{2,3}$/.test(lang) ? lang : "auto";
}

/** `-m <model> -f <wav> -l <lang> -nt -np`: plain text on stdout, nothing else. */
export function whisperArgs(model: string, wav: string, language: string): string[] {
  return ["-m", model, "-f", wav, "-l", language, "-nt", "-np"];
}

/** whisper prints one line per segment; one line of dictation is wanted. */
export function cleanTranscript(stdout: string): string {
  return stdout
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\[(BLANK_AUDIO|MUSIC|NOISE)\]$/i.test(l))
    .join(" ")
    .trim();
}

/** A 44-byte RIFF header in front of 16-bit mono PCM. */
export function pcmToWav(chunks: readonly Uint8Array[], sampleRate = WHISPER_SAMPLE_RATE): Buffer {
  const dataLen = chunks.reduce((n, c) => n + c.byteLength, 0);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);        // PCM fmt chunk size
  header.writeUInt16LE(1, 20);         // PCM
  header.writeUInt16LE(1, 22);         // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);         // block align
  header.writeUInt16LE(16, 34);        // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, ...chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))]);
}
