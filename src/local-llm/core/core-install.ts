import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { downloadFile, discardPartialDownload, type DownloadFileOptions } from "../downloads/download-file.js";
import { activeCoreVersion, CORE_REPO, CORE_VERSION, CORE_VERSIONS, coreBinary, coreRoot, coreVersionDir, readCoreJson, writeCoreJson } from "./core-state.js";
import { isNewerVersion } from "../../update/compare-semver.js";


export function coreAssetName(version: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (arch !== "arm64" && arch !== "x64") throw new Error(`Atomic Core does not support ${arch}.`);
  const cpu = arch === "arm64" ? "aarch64" : "x86_64";
  const target = platform === "darwin" ? "apple-darwin" : platform === "linux" ? "unknown-linux-gnu" : platform === "win32" ? "pc-windows-msvc.exe" : null;
  if (!target) throw new Error(`Atomic Core does not support ${platform}.`);
  return `atomic-chat-core-${version}-${cpu}-${target}`;
}

export function coreChecksum(text: string, asset: string): string {
  const hashes = text.split(/\r?\n/).flatMap(line => {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    return match?.[2] === asset ? [match[1]!.toLowerCase()] : [];
  });
  if (hashes.length !== 1) throw new Error("Atomic Core checksum manifest is missing or ambiguous for this platform.");
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

export async function installCore(dataDir: string, version = CORE_VERSION, opts: DownloadFileOptions = {}): Promise<void> {
  const dir = coreVersionDir(dataDir, version); // validates before building paths or URLs
  if (isCoreInstalled(dataDir, version)) return;
  const asset = coreAssetName(version);
  const base = `https://github.com/${CORE_REPO}/releases/download/v${version}`;
  const response = await fetch(`${base}/SHA256SUMS`, { signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Could not fetch Atomic Core checksums (${response.status}).`);
  const expected = coreChecksum(await response.text(), asset);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stage = join(dir, `download-${randomUUID()}${process.platform === "win32" ? ".exe" : ""}`);
  try {
    await downloadFile(`${base}/${asset}`, stage, opts);
    if (await sha256(stage) !== expected) throw new Error("Atomic Core download failed checksum verification. The previous engine is unchanged.");
    if (process.platform !== "win32") chmodSync(stage, 0o755);
    const result = await promisify(execFile)(stage, ["--version"], { timeout: 15_000, windowsHide: true, maxBuffer: 4096 });
    if (result.stdout.trim() !== version) throw new Error("Atomic Core binary does not match its release version.");
    opts.signal?.throwIfAborted();
    // Never overwrite a running verified install. Concurrent identical downloads converge here.
    if (!isCoreInstalled(dataDir, version)) {
      renameSync(stage, coreBinary(dataDir, version));
      writeCoreJson(join(dir, "verified.json"), { version, sha256: expected });
    }
  } finally {
    rmSync(stage, { force: true });
    discardPartialDownload(stage);
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
