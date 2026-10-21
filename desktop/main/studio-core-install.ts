/**
 * Studio: put Atomic Chat Core in place when nothing else has.
 *
 * Why: a fresh install that chose the cloud route never starts a local chat
 * model, so nothing installs Core, and a dev run (or a seed that failed) has
 * no bundled copy either. Every Studio call then failed with
 * CORE_NOT_INSTALLED, even listing cloud models. The agent's own image tool
 * installs Core in that case (src/local-llm/core/core-image.ts
 * `withImageCore` → src/local-llm/core/core-install.ts `installCore`);
 * this mirrors that install, since the desktop cannot import src/ at
 * runtime. No Electron here, so the unit suite loads it from `out/main`.
 *
 * Same as installCore:
 *   - asset `atomic-chat-core-<v>-<aarch64|x86_64>-<apple-darwin|
 *     unknown-linux-gnu|pc-windows-msvc.exe>` from the GitHub release
 *     `AtomicBot-ai/atomic-chat-core` `v<v>` (no mirror: the agent's install
 *     has none either; HF_ENDPOINT is for Hugging Face only);
 *   - the hash from the release's `SHA256SUMS` (exactly one line for the
 *     asset), checked before anything is put in place;
 *   - `<binary> --version` must print the version;
 *   - `<dataDir>/core/versions/<v>/atomic-chat-core[.exe]` 0755, the
 *     directories 0700, and `verified.json` 0600 written to a temp name and
 *     renamed: `{"version":"<v>","sha256":"<64 lowercase hex>"}\n`
 *     (core-state.ts `writeCoreJson`, core-seed.ts);
 *   - a valid install that appeared meanwhile wins and is never overwritten;
 *   - up to 3 attempts for a network failure or a 5xx/408/429.
 *
 * The caller holds the engine operation lock (studio-core-start.ts
 * `withStudioOperation`), as installCore runs under `withCoreOperation`.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import { coreBinaryRuns, type CoreVersionProbe } from "./core-seed.js";

export const CORE_REPO = "AtomicBot-ai/atomic-chat-core";
export const CORE_INSTALL_ATTEMPTS = 3;
/** A download that moves no byte for this long is given up (installCore: two minutes). */
const STALL_MS = 2 * 60_000;

/** Why the install did not happen, in words for "Could not install the engine: <reason>." */
export class CoreInstallError extends Error {
  override readonly name = "CoreInstallError";
  constructor(message: string, readonly retryable = false) { super(message); }
}

/** The release asset for a platform and CPU (core-install.ts `coreAssetName`). */
export function coreAssetName(version: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (arch !== "arm64" && arch !== "x64") throw new CoreInstallError(`Atomic Core does not support ${arch}`);
  const cpu = arch === "arm64" ? "aarch64" : "x86_64";
  const target = platform === "darwin" ? "apple-darwin" : platform === "linux" ? "unknown-linux-gnu" : platform === "win32" ? "pc-windows-msvc.exe" : null;
  if (!target) throw new CoreInstallError(`Atomic Core does not support ${platform}`);
  return `atomic-chat-core-${version}-${cpu}-${target}`;
}

/** The lowercase sha256 `SHA256SUMS` gives `asset`; exactly one line must name it (core-install.ts `coreChecksum`). */
export function coreChecksum(text: string, asset: string): string {
  const hashes = text.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    return match?.[2] === asset ? [match[1]!.toLowerCase()] : [];
  });
  if (hashes.length !== 1) throw new CoreInstallError("the checksum list is missing or ambiguous for this computer");
  return hashes[0]!;
}

/** verified.json's bytes, exactly as the agent and core-seed.ts write them. */
export function coreVerifiedRecord(version: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new CoreInstallError("not a sha256");
  return JSON.stringify({ version, sha256 }) + "\n";
}

export function coreBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "atomic-chat-core.exe" : "atomic-chat-core";
}

export function coreReleaseBase(version: string): string {
  return `https://github.com/${CORE_REPO}/releases/download/v${version}`;
}

/** The agent's `isCoreInstalled` for one version: a verified.json naming it with a sha256, and the binary. */
export async function isStudioCoreInstalled(dataDir: string, version: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const versionDir = join(resolve(dataDir, "core"), "versions", version);
  try {
    const record = JSON.parse(await readFile(join(versionDir, "verified.json"), "utf8")) as { version?: unknown; sha256?: unknown };
    if (record?.version !== version || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) return false;
    return (await stat(join(versionDir, coreBinaryName(platform)))).isFile();
  } catch {
    return false;
  }
}

export interface CoreInstallProgress {
  transferred: number;
  /** From Content-Length; null when the server does not say. */
  total: number | null;
  /** 0..100, or null without a total. */
  percent: number | null;
}

export interface StudioCoreInstallOptions {
  signal?: AbortSignal;
  request?: typeof fetch;
  onProgress?: (p: CoreInstallProgress) => void;
  /** `<binary> --version`; tests stand in for it. */
  probe?: CoreVersionProbe;
  platform?: NodeJS.Platform;
  arch?: string;
  retryDelayMs?: number;
  stallMs?: number;
}

const cancelled = (signal?: AbortSignal) => signal?.aborted === true;

function httpFailure(what: string, status: number): CoreInstallError {
  return new CoreInstallError(`GitHub answered HTTP ${status} for ${what}`, status >= 500 || status === 408 || status === 429);
}

function networkFailure(err: unknown): CoreInstallError {
  const why = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
  return new CoreInstallError(`the download failed (${why})`, true);
}

/** Up to CORE_INSTALL_ATTEMPTS tries with backoff (1s, 2s) while the failure is retryable; cancellation ends it at once. */
async function withRetries<T>(attempt: () => Promise<T>, signal: AbortSignal | undefined, baseMs: number): Promise<T> {
  for (let n = 1; ; n++) {
    try { return await attempt(); } catch (err) {
      if (cancelled(signal)) throw err;
      if (n >= CORE_INSTALL_ATTEMPTS || !(err instanceof CoreInstallError && err.retryable)) throw err;
      await delay(baseMs * 2 ** (n - 1), undefined, signal ? { signal } : {});
    }
  }
}

async function fetchChecksums(base: string, opts: StudioCoreInstallOptions): Promise<string> {
  const request = opts.request ?? fetch;
  return withRetries(async () => {
    const timeout = AbortSignal.timeout(15_000);
    let res: Response;
    try {
      res = await request(`${base}/SHA256SUMS`, { headers: { "User-Agent": "atomic-agent/studio" }, redirect: "follow", signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout });
    } catch (err) {
      opts.signal?.throwIfAborted();
      throw networkFailure(err);
    }
    if (!res.ok) throw httpFailure("the checksum list", res.status);
    return await res.text();
  }, opts.signal, opts.retryDelayMs ?? 1_000);
}

/** One download of `url` into `path` (truncated first), hashed as it streams. Returns the sha256. */
async function downloadOnce(url: string, path: string, opts: StudioCoreInstallOptions): Promise<string> {
  const request = opts.request ?? fetch;
  const stall = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, stall.signal]) : stall.signal;
  const stallMs = opts.stallMs ?? STALL_MS;
  let timer = setTimeout(() => stall.abort(), stallMs);
  const poke = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(), stallMs); };
  try {
    let res: Response;
    try {
      res = await request(url, { headers: { "User-Agent": "atomic-agent/studio" }, redirect: "follow", signal });
    } catch (err) {
      opts.signal?.throwIfAborted();
      throw networkFailure(stall.signal.aborted ? new Error("no data for two minutes") : err);
    }
    if (!res.ok || !res.body) throw httpFailure("the engine download", res.status);
    const length = Number(res.headers.get("content-length"));
    const total = Number.isFinite(length) && length > 0 ? length : null;
    const hash = createHash("sha256");
    let transferred = 0;
    let lastPct = -1;
    let lastBytes = 0;
    opts.onProgress?.({ transferred: 0, total, percent: total ? 0 : null });
    const counter = new Transform({
      transform(chunk: Buffer, _e, done) {
        transferred += chunk.length;
        hash.update(chunk);
        poke();
        const percent = total ? Math.min(100, Math.floor((transferred / total) * 100)) : null;
        // One event per percent, or per MiB when the size is unknown: not one per chunk.
        if (percent !== null ? percent !== lastPct : transferred - lastBytes >= 1 << 20) {
          if (percent !== null) lastPct = percent;
          lastBytes = transferred;
          opts.onProgress?.({ transferred, total, percent });
        }
        done(null, chunk);
      },
    });
    const body = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream);
    try {
      await pipeline(body, counter, createWriteStream(path, { flags: "w", mode: 0o600 }), { signal });
    } catch (err) {
      opts.signal?.throwIfAborted();
      if ((err as NodeJS.ErrnoException)?.code === "ENOSPC") throw new CoreInstallError("the disk is full");
      throw networkFailure(stall.signal.aborted ? new Error("no data for two minutes") : err);
    }
    if (total !== null && transferred !== total) throw new CoreInstallError(`the download ended early (${transferred} of ${total} bytes)`, true);
    return hash.digest("hex");
  } finally {
    clearTimeout(timer);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Download, verify and place Core `version` for this computer. Returns at
 * once when a valid install is there. Throws CoreInstallError with the
 * reason, or the signal's reason when cancelled.
 */
export async function installStudioCore(dataDir: string, version: string, opts: StudioCoreInstallOptions = {}): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new CoreInstallError(`not a Core version: ${version}`);
  const platform = opts.platform ?? process.platform;
  if (await isStudioCoreInstalled(dataDir, version, platform)) return;
  const asset = coreAssetName(version, platform, opts.arch ?? process.arch);
  const base = coreReleaseBase(version);
  const expected = coreChecksum(await fetchChecksums(base, opts), asset);

  const versionDir = join(resolve(dataDir, "core"), "versions", version);
  const binary = join(versionDir, coreBinaryName(platform));
  const win = platform === "win32";
  // Own staging name: the agent's installCore resumes its own `download-<v>` partial, never this one.
  const stage = join(versionDir, `studio-download-${randomUUID()}${win ? ".exe" : ""}`);
  const recordPath = join(versionDir, "verified.json");
  const recordTmp = `${recordPath}.${randomUUID()}.tmp`;
  try {
    await mkdir(versionDir, { recursive: true, mode: 0o700 });
    let got = await withRetries(() => downloadOnce(`${base}/${asset}`, stage, opts), opts.signal, opts.retryDelayMs ?? 1_000);
    // Hash what is on disk too: the streamed hash and the file must agree.
    if (got === expected) got = await sha256File(stage);
    if (got !== expected) throw new CoreInstallError("the file did not match its published checksum, so it was discarded");
    if (!win) await chmod(stage, 0o755);
    opts.signal?.throwIfAborted();
    const runs = await coreBinaryRuns(stage, version, opts.probe);
    if (!runs.ok) throw new CoreInstallError(`the downloaded engine failed its check: ${runs.reason}`);
    opts.signal?.throwIfAborted();
    // A valid install that appeared meanwhile (the agent, a seed) wins.
    if (await isStudioCoreInstalled(dataDir, version, platform)) return;
    await rename(stage, binary);
    await writeFile(recordTmp, coreVerifiedRecord(version, expected), { mode: 0o600 });
    await rename(recordTmp, recordPath);
  } finally {
    await rm(stage, { force: true }).catch(() => {});
    await rm(recordTmp, { force: true }).catch(() => {});
  }
}
