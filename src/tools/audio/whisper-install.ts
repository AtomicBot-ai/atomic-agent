import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { downloadFile } from "../../local-llm/downloads/download-file.js";
import { TarBackend } from "../os/archive/tar-backend.js";
import { ZipBackend } from "../os/archive/zip-backend.js";
import {
  managedWhisperBinary,
  managedWhisperDir,
  WHISPER_RELEASE,
  whisperAssetUrl,
  type WhisperAsset,
} from "./whisper-release.js";
import { whisperModelPath, whisperModelUrl, type WhisperModel } from "./whisper-models.js";

/**
 * First-use downloads for `audio.transcribe` (ATO-702, decision 75): the
 * pinned whisper.cpp build and a ggml model, each through the agent's
 * resumable `downloadFile`, each checked against its published SHA-256
 * before it is used, so a cut or tampered file is thrown away instead of
 * run. Callers ask for approval first; nothing here asks.
 */

export type WhisperDownloadItem = "engine" | "model";

export interface InstallProgress {
  item: WhisperDownloadItem;
  transferred: number;
  total: number;
}

export interface InstallDeps {
  download?: (url: string, dest: string, opts: { signal: AbortSignal; onProgress: (transferred: number, total: number) => void }) => Promise<void>;
  hashFile?: (path: string) => Promise<string>;
  extract?: (archive: string, format: WhisperAsset["format"], destDir: string) => Promise<void>;
}

export interface InstallOptions {
  signal: AbortSignal;
  onProgress?: (p: InstallProgress) => void;
  deps?: InstallDeps;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const defaultDownload: NonNullable<InstallDeps["download"]> = (url, dest, opts) =>
  downloadFile(url, dest, { signal: opts.signal, onProgress: (_percent, transferred, total) => opts.onProgress(transferred, total) });

/** The release archives hold ~40 files of a few MB; the caps only stop a runaway archive. */
const EXTRACT_LIMITS = { maxTotalBytes: 400 * 1024 * 1024, maxEntryBytes: 100 * 1024 * 1024, maxEntries: 5_000 };

const defaultExtract: NonNullable<InstallDeps["extract"]> = async (archive, format, destDir) => {
  const data = await readFile(archive);
  const backend = format === "zip" ? new ZipBackend() : new TarBackend("tar.gz");
  // Symlinks are kept: the Linux build finds `libwhisper.so.1` through one.
  // The extractor still refuses any link or path that leaves `destDir`.
  await backend.extract(data, { destDir, overwrite: true, followSymlinks: true, limits: EXTRACT_LIMITS });
};

async function findFile(root: string, name: string): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) if (e.isFile() && e.name === name) return join(root, e.name);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = await findFile(join(root, e.name), name);
    if (hit) return hit;
  }
  return null;
}

/** The extractor does not carry file modes; the CLI and its libraries must be executable. */
async function markExecutable(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isFile()) await chmod(join(dir, e.name), 0o755).catch(() => undefined);
  }
}

async function verified(path: string, expected: string, what: string, hashFile: (p: string) => Promise<string>): Promise<void> {
  const actual = await hashFile(path);
  if (actual !== expected) {
    await rm(path, { force: true });
    throw new Error(`${what} did not match its published SHA-256 and was discarded (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
  }
}

/**
 * Download, verify and unpack the pinned whisper.cpp build into
 * `<models dir>/whisper/bin/<tag>/`. Returns the CLI's path; a build
 * already there is returned as is.
 */
export async function installWhisperBinary(
  localModelsDataDir: string,
  asset: WhisperAsset,
  platform: NodeJS.Platform,
  options: InstallOptions,
): Promise<string> {
  const bin = managedWhisperBinary(localModelsDataDir, platform);
  if (existsSync(bin)) return bin;
  const download = options.deps?.download ?? defaultDownload;
  const hashFile = options.deps?.hashFile ?? sha256File;
  const extract = options.deps?.extract ?? defaultExtract;
  const finalDir = managedWhisperDir(localModelsDataDir);
  const root = dirname(finalDir);
  await mkdir(root, { recursive: true });
  const archive = join(root, `${WHISPER_RELEASE.tag}-${asset.name}`);
  const staging = join(root, `${WHISPER_RELEASE.tag}.staging-${process.pid}`);
  try {
    await download(whisperAssetUrl(asset), archive, {
      signal: options.signal,
      onProgress: (transferred, total) => options.onProgress?.({ item: "engine", transferred, total: total || asset.sizeBytes }),
    });
    await verified(archive, asset.sha256, `The whisper.cpp download (${asset.name})`, hashFile);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await extract(archive, asset.format, staging);
    const found = await findFile(staging, asset.binary);
    if (!found) throw new Error(`${asset.binary} was not in ${asset.name}`);
    await rm(finalDir, { recursive: true, force: true });
    await rename(dirname(found), finalDir);
    if (platform !== "win32") await markExecutable(finalDir);
    return bin;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await rm(archive, { force: true }).catch(() => undefined);
  }
}

/**
 * Download and verify one ggml model into `<models dir>/whisper/`.
 * Returns its path; a complete file already there is returned as is.
 */
export async function installWhisperModel(
  localModelsDataDir: string,
  model: WhisperModel,
  options: InstallOptions,
): Promise<string> {
  const path = whisperModelPath(localModelsDataDir, model);
  try {
    if ((await stat(path)).size === model.sizeBytes) return path;
  } catch {
    /* not there yet */
  }
  const download = options.deps?.download ?? defaultDownload;
  const hashFile = options.deps?.hashFile ?? sha256File;
  await mkdir(dirname(path), { recursive: true });
  // Downloaded beside the final name and renamed only once verified, so
  // the lookup never sees a half or a wrong file.
  const pending = `${path}.download`;
  await download(whisperModelUrl(model), pending, {
    signal: options.signal,
    onProgress: (transferred, total) => options.onProgress?.({ item: "model", transferred, total: total || model.sizeBytes }),
  });
  await verified(pending, model.sha256, `The speech model ${model.file}`, hashFile);
  await rename(pending, path);
  return path;
}
