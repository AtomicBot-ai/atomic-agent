import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { downloadFile } from "../../local-llm/downloads/download-file.js";
import {
  DIARIZE_BINARY,
  DIARIZE_RELEASE,
  diarizeAssetUrl,
  diarizeDir,
  diarizeModelPath,
  managedDiarizeBinary,
  managedDiarizeDir,
  type DiarizeAsset,
  type DiarizeModel,
} from "./diarize-release.js";
import { sha256File } from "./whisper-install.js";

/**
 * First-use downloads for speaker diarization (ATO-2514): the pinned
 * sherpa-onnx build and its two models, each through the agent's resumable
 * `downloadFile` and checked against its published SHA-256 before it is
 * used, like whisper.cpp (whisper-install.ts). The release is a `.tar.bz2`,
 * which the agent's own tar code cannot read (gzip only), so it is unpacked
 * by the system `tar` (bsdtar on macOS and Windows 10+, GNU tar on Linux),
 * only after the digest matched, into a staging folder renamed into place.
 */

export type DiarizeDownloadItem = "engine" | "segmentation" | "embedding";

export interface DiarizeInstallProgress {
  item: DiarizeDownloadItem;
  transferred: number;
  total: number;
}

export interface DiarizeInstallDeps {
  download?: (url: string, dest: string, opts: { signal: AbortSignal; onProgress: (transferred: number, total: number) => void }) => Promise<void>;
  hashFile?: (path: string) => Promise<string>;
  /** Unpacks a `.tar.bz2` into `destDir`. */
  extract?: (archive: string, destDir: string) => Promise<void>;
}

export interface DiarizeInstallOptions {
  signal: AbortSignal;
  onProgress?: (p: DiarizeInstallProgress) => void;
  deps?: DiarizeInstallDeps;
}

const defaultDownload: NonNullable<DiarizeInstallDeps["download"]> = (url, dest, opts) =>
  downloadFile(url, dest, { signal: opts.signal, onProgress: (_percent, transferred, total) => opts.onProgress(transferred, total) });

const defaultExtract: NonNullable<DiarizeInstallDeps["extract"]> = (archive, destDir) =>
  new Promise((resolve, reject) => {
    execFile("tar", ["-xjf", archive, "-C", destDir], { windowsHide: true, timeout: 300_000 }, (err) =>
      err ? reject(new Error(`could not unpack ${basename(archive)}: ${err.message}`)) : resolve());
  });

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

async function verified(path: string, expected: string, what: string, hashFile: (p: string) => Promise<string>): Promise<void> {
  const actual = await hashFile(path);
  if (actual !== expected) {
    await rm(path, { force: true });
    throw new Error(`${what} did not match its published SHA-256 and was discarded (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
  }
}

/** The release carries ~60 example CLIs; only the diarizer and the libraries are kept. */
export function isUnusedTool(name: string, platform: NodeJS.Platform): boolean {
  const keep = platform === "win32" ? `${DIARIZE_BINARY}.exe` : DIARIZE_BINARY;
  if (name === keep || !name.startsWith("sherpa-onnx")) return false;
  return !/\.(dll|so(\.\d+)*|dylib|lib)$/i.test(name);
}

async function tidy(dir: string, platform: NodeJS.Platform): Promise<void> {
  const bin = join(dir, "bin");
  for (const e of await readdir(bin, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile() && isUnusedTool(e.name, platform)) await rm(join(bin, e.name), { force: true });
  }
  if (platform === "win32") return;
  // tar keeps modes, but a umask or a copied folder may not: the CLI and its libraries must run.
  for (const sub of ["bin", "lib"]) {
    for (const e of await readdir(join(dir, sub), { withFileTypes: true }).catch(() => [])) {
      if (e.isFile()) await chmod(join(dir, sub, e.name), 0o755).catch(() => undefined);
    }
  }
}

/**
 * Download, verify and unpack the pinned build into
 * `<models dir>/diarize/bin/<tag>/`. Returns the CLI's path; a build
 * already there is returned as is.
 */
export async function installDiarizeEngine(
  localModelsDataDir: string,
  asset: DiarizeAsset,
  platform: NodeJS.Platform,
  options: DiarizeInstallOptions,
): Promise<string> {
  const bin = managedDiarizeBinary(localModelsDataDir, platform);
  try {
    if ((await stat(bin)).isFile()) return bin;
  } catch {
    /* not there yet */
  }
  const download = options.deps?.download ?? defaultDownload;
  const hashFile = options.deps?.hashFile ?? sha256File;
  const extract = options.deps?.extract ?? defaultExtract;
  const finalDir = managedDiarizeDir(localModelsDataDir);
  const root = dirname(finalDir);
  await mkdir(root, { recursive: true });
  const archive = join(root, asset.name);
  const staging = join(root, `${DIARIZE_RELEASE.tag}.staging-${process.pid}`);
  try {
    await download(diarizeAssetUrl(asset), archive, {
      signal: options.signal,
      onProgress: (transferred, total) => options.onProgress?.({ item: "engine", transferred, total: total || asset.sizeBytes }),
    });
    await verified(archive, asset.sha256, `The speaker diarization download (${asset.name})`, hashFile);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await extract(archive, staging);
    const found = await findFile(staging, basename(bin));
    if (!found) throw new Error(`${basename(bin)} was not in ${asset.name}`);
    if (basename(dirname(found)) !== "bin") throw new Error(`${asset.name} is not laid out as bin/ and lib/`);
    await rm(finalDir, { recursive: true, force: true });
    await rename(dirname(dirname(found)), finalDir);
    await tidy(finalDir, platform);
    return bin;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await rm(archive, { force: true }).catch(() => undefined);
  }
}

/** Download and verify one model into `<models dir>/diarize/`; a complete file already there is kept. */
export async function installDiarizeModel(
  localModelsDataDir: string,
  model: DiarizeModel,
  options: DiarizeInstallOptions,
): Promise<string> {
  const path = diarizeModelPath(localModelsDataDir, model);
  try {
    if ((await stat(path)).size === model.sizeBytes) return path;
  } catch {
    /* not there yet */
  }
  const download = options.deps?.download ?? defaultDownload;
  const hashFile = options.deps?.hashFile ?? sha256File;
  await mkdir(diarizeDir(localModelsDataDir), { recursive: true });
  // Beside the final name, renamed only once verified: the lookup never sees a half file.
  const pending = `${path}.download`;
  await download(model.url, pending, {
    signal: options.signal,
    onProgress: (transferred, total) => options.onProgress?.({ item: model.role, transferred, total: total || model.sizeBytes }),
  });
  await verified(pending, model.sha256, `The speaker model ${model.file}`, hashFile);
  await rename(pending, path);
  return path;
}

/** The engine and the models are deleted (Settings' Remove). */
export async function removeDiarize(localModelsDataDir: string): Promise<void> {
  await rm(diarizeDir(localModelsDataDir), { recursive: true, force: true });
}
