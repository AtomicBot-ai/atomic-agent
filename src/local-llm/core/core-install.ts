import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { downloadFile, discardPartialDownload, type DownloadFileOptions } from "../downloads/download-file.js";
import { CoreUnavailableError, isCoreCancellation, toCoreUnavailable } from "./core-errors.js";
import { activeCoreVersion, CORE_REPO, CORE_VERSION, CORE_VERSIONS, coreBinary, coreRoot, coreVersionDir, readCoreJson, writeCoreJson } from "./core-state.js";
import { isNewerVersion } from "../../update/compare-semver.js";


export function coreAssetName(version: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (arch !== "arm64" && arch !== "x64") throw new CoreUnavailableError({ stage: "download", reasonCode: "unsupported", detail: `Atomic Core does not support ${arch}` });
  const cpu = arch === "arm64" ? "aarch64" : "x86_64";
  const target = platform === "darwin" ? "apple-darwin" : platform === "linux" ? "unknown-linux-gnu" : platform === "win32" ? "pc-windows-msvc.exe" : null;
  if (!target) throw new CoreUnavailableError({ stage: "download", reasonCode: "unsupported", detail: `Atomic Core does not support ${platform}` });
  return `atomic-chat-core-${version}-${cpu}-${target}`;
}

export function coreChecksum(text: string, asset: string): string {
  const hashes = text.split(/\r?\n/).flatMap(line => {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    return match?.[2] === asset ? [match[1]!.toLowerCase()] : [];
  });
  if (hashes.length !== 1) throw new CoreUnavailableError({ stage: "verify", reasonCode: "checksum", detail: "Atomic Core checksum manifest is missing or ambiguous for this platform" });
  return hashes[0]!;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function isCoreInstalled(dataDir: string, version = activeCoreVersion(dataDir)): boolean {
  const record = readCoreJson<{ version?: string; sha256?: string }>(join(coreVersionDir(dataDir, version), "verified.json"));
  return record?.version === version && typeof record.sha256 === "string" && /^[a-f0-9]{64}$/.test(record.sha256) && existsSync(coreBinary(dataDir, version));
}

/** Attempts for each Core download (checksums and binary). A cancelled one is never retried. */
export const CORE_DOWNLOAD_ATTEMPTS = 3;
const CORE_RETRY_BASE_MS = 1_000;

/** A network failure or a 5xx/408/429 is worth another attempt; anything else is not. */
function isRetryableFetchFailure(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status >= 500 || status === 408 || status === 429;
  return err instanceof Error && (err.name === "TimeoutError" || (err instanceof TypeError && /fetch failed/.test(err.message)));
}

class ChecksumFetchError extends Error {
  constructor(readonly status: number) { super(`Could not fetch Atomic Core checksums (${status})`); }
}

/**
 * Run `attempt` up to CORE_DOWNLOAD_ATTEMPTS times with exponential backoff
 * (1s, 2s) while `retryable` says so. Cancellation ends it at once.
 */
export async function withCoreRetries<T>(attempt: () => Promise<T>, retryable: (err: unknown) => boolean, signal?: AbortSignal, baseDelayMs = CORE_RETRY_BASE_MS): Promise<T> {
  for (let n = 1; ; n++) {
    try { return await attempt(); }
    catch (err) {
      if (isCoreCancellation(err, signal) || n >= CORE_DOWNLOAD_ATTEMPTS || !retryable(err)) throw err;
      await delay(baseDelayMs * 2 ** (n - 1), undefined, signal ? { signal } : {});
    }
  }
}

async function fetchCoreChecksums(base: string, signal: AbortSignal | undefined, request: typeof fetch): Promise<string> {
  return withCoreRetries(async () => {
    const timeout = AbortSignal.timeout(15_000);
    const response = await request(`${base}/SHA256SUMS`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new ChecksumFetchError(response.status);
    return await response.text();
  }, isRetryableFetchFailure, signal);
}

/**
 * The binary download retries inside downloadFile: up to 3 server errors
 * (5xx/408/429) with exponential backoff from 1s, and network failures with
 * the same backoff until two minutes pass without a new byte. Every retry
 * resumes the partial with a Range request; a server without Range support
 * restarts it. The staging path is stable per version, so a partial left by
 * a failed or cancelled run is resumed by the next one ("download again").
 * Bounded so a failure surfaces with a clear next step instead of a hang.
 */
function coreDownloadOptions(opts: DownloadFileOptions): DownloadFileOptions {
  return { ...opts, maxRetries: Math.min(opts.maxRetries ?? CORE_DOWNLOAD_ATTEMPTS, CORE_DOWNLOAD_ATTEMPTS), retryDelayMs: opts.retryDelayMs ?? CORE_RETRY_BASE_MS, giveUpAfterMs: opts.giveUpAfterMs ?? 2 * 60_000 };
}

export async function installCore(dataDir: string, version = CORE_VERSION, opts: DownloadFileOptions = {}, request: typeof fetch = fetch): Promise<void> {
  const dir = coreVersionDir(dataDir, version); // validates before building paths or URLs
  if (isCoreInstalled(dataDir, version)) return;
  const asset = coreAssetName(version);
  const base = `https://github.com/${CORE_REPO}/releases/download/v${version}`;
  let manifest: string;
  try { manifest = await fetchCoreChecksums(base, opts.signal, request); }
  catch (err) { throw toCoreUnavailable(err, "download", opts.signal); }
  const expected = coreChecksum(manifest, asset);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stage = join(dir, `download-${version}${process.platform === "win32" ? ".exe" : ""}`);
  // A partial survives a failed download for the next attempt to resume. Bytes
  // that did not verify, or a finished install, never do.
  let keepPartial = false;
  try {
    try { await downloadFile(`${base}/${asset}`, stage, coreDownloadOptions(opts)); }
    catch (err) { keepPartial = true; throw toCoreUnavailable(err, "download", opts.signal); }
    if (await sha256(stage) !== expected) throw new CoreUnavailableError({ stage: "verify", reasonCode: "checksum", detail: "the file did not match its published checksum, so it was discarded. The previous engine is unchanged" });
    if (process.platform !== "win32") chmodSync(stage, 0o755);
    let result: { stdout: string };
    try { result = await promisify(execFile)(stage, ["--version"], { timeout: 15_000, windowsHide: true, maxBuffer: 4096 }); }
    catch (err) { throw new CoreUnavailableError({ stage: "verify", reasonCode: "spawn", detail: `the downloaded binary would not run (${err instanceof Error ? err.message : String(err)})`, cause: err }); }
    if (result.stdout.trim() !== version) throw new CoreUnavailableError({ stage: "verify", reasonCode: "version", detail: "the binary does not match its release version" });
    opts.signal?.throwIfAborted();
    // Never overwrite a running verified install. Concurrent identical downloads converge here.
    if (!isCoreInstalled(dataDir, version)) {
      renameSync(stage, coreBinary(dataDir, version));
      writeCoreJson(join(dir, "verified.json"), { version, sha256: expected });
    }
  } finally {
    rmSync(stage, { force: true });
    if (!keepPartial) discardPartialDownload(stage);
  }
}

export interface CoreUpdateCheck {
  currentVersion: string | null;
  compatibleVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  requiresAgentUpdate: boolean;
}
export async function checkCoreUpdate(dataDir: string, request: typeof fetch = fetch, force = false): Promise<CoreUpdateCheck> {
  const cachePath = join(coreRoot(dataDir), "release-check.json");
  const cached = readCoreJson<{ checkedAt: number; latestVersion: string }>(cachePath);
  let latestVersion = cached && Date.now() - cached.checkedAt < 6 * 60 * 60_000 && /^\d+\.\d+\.\d+$/.test(cached.latestVersion) ? cached.latestVersion : null;
  if (!latestVersion || force) {
  const response = await request(`https://api.github.com/repos/${CORE_REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "atomic-agent" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Could not check Atomic Core updates (${response.status}).`);
  const value = await response.json() as { tag_name?: unknown };
  if (typeof value.tag_name !== "string" || !/^v?\d+\.\d+\.\d+$/.test(value.tag_name)) throw new Error("Atomic Core release information is invalid.");
  latestVersion = value.tag_name.replace(/^v/, "");
  writeCoreJson(cachePath, { checkedAt: Date.now(), latestVersion });
  }
  const version = activeCoreVersion(dataDir);
  const currentVersion = isCoreInstalled(dataDir, version) ? version : null;
  return { currentVersion, compatibleVersion: CORE_VERSION, latestVersion,
    updateAvailable: currentVersion === null || isNewerVersion(CORE_VERSION, currentVersion),
    requiresAgentUpdate: isNewerVersion(latestVersion, CORE_VERSION) && !CORE_VERSIONS.includes(latestVersion as typeof CORE_VERSIONS[number]),
  };
}
