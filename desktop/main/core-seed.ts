import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { BUNDLED_CORE_VERSION, bundledCoreFileName } from "./core-bundle.js";

/**
 * Put the Atomic Chat Core the installer carries where the agent looks for it.
 *
 * Why: without this the first local model on a fresh machine starts with a
 * ~70-120 MB Core download from GitHub (src/local-llm/core/core-install.ts
 * `installCore`). The installer already has the binary in
 * `<resources>/core/` (scripts/fetch-core.mjs, electron-builder.cjs), and that
 * copy is signed by our own certificate (Developer ID on macOS, DigiCert on
 * Windows), so seeding it means no network on first run and no binary on the
 * machine that we did not sign.
 *
 * Where: the agent's own layout (src/local-llm/core/core-state.ts), which
 * `isCoreInstalled` checks:
 *   <dataDir>/core/versions/<version>/atomic-chat-core[.exe]   0755
 *   <dataDir>/core/versions/<version>/verified.json            0600
 *     {"version":"<version>","sha256":"<64 lowercase hex>"}\n
 * with the directories 0700.
 *
 * The sha256 is of the file as it sits on disk after the copy, NOT the
 * release's SHA256SUMS hash: codesign and signtool rewrite the bytes, so the
 * signed binary never matches the release. The release hash was checked at
 * build time, before signing (fetch-core.mjs).
 *
 * Rules: a valid install is never touched (the agent may have installed or be
 * running that version); the copy goes to a temp name in the same directory
 * and is renamed into place, so the agent never sees half a binary; it never
 * throws, it says why it did nothing. It does not write `active.json`: which
 * version is active stays the agent's decision (core-backend.ts pairs it with
 * the backend it installs).
 */

export interface CoreSeedResult {
  seeded: boolean;
  reason?: string;
}

/** What `<binary> --version` printed (trimmed), or why it could not run. */
export type CoreVersionProbe = (binary: string) => Promise<{ version: string } | { error: string }>;

export const CORE_VERSION_PROBE_TIMEOUT_MS = 10_000;

/** Run `<binary> --version`, bounded; never throws. */
export const probeCoreVersion: CoreVersionProbe = async (binary) => {
  try {
    const { stdout } = await promisify(execFile)(binary, ["--version"], { timeout: CORE_VERSION_PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4096 });
    return { version: String(stdout).trim() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
};

/** macOS only, best effort: a quarantined copy can be refused by Gatekeeper on first spawn. */
export async function stripQuarantine(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== "darwin") return;
  await promisify(execFile)("/usr/bin/xattr", ["-d", "com.apple.quarantine", path], { timeout: 5_000 }).catch(() => {});
}

/** Does `<binary> --version` print exactly `version`? Same check the agent's installCore makes. */
export async function coreBinaryRuns(binary: string, version: string, probe: CoreVersionProbe = probeCoreVersion): Promise<{ ok: true } | { ok: false; reason: string }> {
  const res = await probe(binary);
  if ("error" in res) return { ok: false, reason: `it would not run (${res.error})` };
  if (res.version !== version) return { ok: false, reason: `it reported version "${res.version.slice(0, 40)}", not ${version}` };
  return { ok: true };
}

/** `<resources>/core/atomic-chat-core[.exe]`; resourcesPath is set by Electron, absent under plain Node. */
export function bundledCorePath(resourcesPath?: string): string | null {
  const root = resourcesPath ?? (process as unknown as { resourcesPath?: string }).resourcesPath;
  return root ? join(root, "core", bundledCoreFileName()) : null;
}

/** The agent's `isCoreInstalled`, for one version: a verified.json naming it with a sha256, and the binary. */
async function hasValidInstall(versionDir: string, binary: string, version: string): Promise<boolean> {
  try {
    const record = JSON.parse(await readFile(join(versionDir, "verified.json"), "utf8")) as { version?: unknown; sha256?: unknown };
    if (record?.version !== version || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) return false;
    return (await stat(binary)).isFile();
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export async function seedBundledCore(dataDir: string, opts: { resourcesPath?: string; probe?: CoreVersionProbe } = {}): Promise<CoreSeedResult> {
  const version = BUNDLED_CORE_VERSION;
  const source = bundledCorePath(opts.resourcesPath);
  if (!source) return { seeded: false, reason: "not a packaged app (no resources path)" };
  try {
    if (!(await stat(source)).isFile()) return { seeded: false, reason: `no bundled Core at ${source}` };
  } catch {
    return { seeded: false, reason: `no bundled Core at ${source}` };
  }

  const versionDir = join(resolve(dataDir, "core"), "versions", version);
  const binary = join(versionDir, bundledCoreFileName());
  if (await hasValidInstall(versionDir, binary, version)) {
    return { seeded: false, reason: `Atomic Core ${version} is already installed` };
  }

  const win = process.platform === "win32";
  const stage = join(versionDir, `seed-${randomUUID()}${win ? ".exe" : ""}`);
  const recordPath = join(versionDir, "verified.json");
  const recordTmp = `${recordPath}.${randomUUID()}.tmp`;
  try {
    await mkdir(versionDir, { recursive: true, mode: 0o700 });
    await copyFile(source, stage);
    if (!win) await chmod(stage, 0o755);
    await stripQuarantine(stage);
    const runs = await coreBinaryRuns(stage, version, opts.probe);
    if (!runs.ok) return { seeded: false, reason: `the bundled Atomic Core ${version} was not seeded: ${runs.reason}` };
    const sha256 = await sha256File(stage);
    /* The agent may have finished its own install while this copied (it
       renames into place too); a valid install wins, as in installCore. */
    if (await hasValidInstall(versionDir, binary, version)) {
      return { seeded: false, reason: `Atomic Core ${version} was installed meanwhile` };
    }
    await rename(stage, binary);
    await writeFile(recordTmp, JSON.stringify({ version, sha256 }) + "\n", { mode: 0o600 });
    await rename(recordTmp, recordPath);
    return { seeded: true };
  } catch (err) {
    return { seeded: false, reason: `could not seed Atomic Core ${version}: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await rm(stage, { force: true }).catch(() => {});
    await rm(recordTmp, { force: true }).catch(() => {});
  }
}

/**
 * Before the recovery card's "Download again": forget the active Core
 * version's verified.json, and its binary too when that does not run.
 *
 * Why: the agent's installCore returns at once while verified.json is
 * well-formed, so a seeded copy that was recorded but cannot start (or a
 * download damaged after it was verified) made "Download again" a no-op that
 * failed the same way every time. Without verified.json the agent downloads
 * and verifies Core again; a binary that still runs is left in place, as the
 * agent's own install renames its fresh copy over it.
 *
 * The version is the one `<dataDir>/core/active.json` names, else the one the
 * installer carries. Never throws; says what it removed.
 */
export async function resetCoreForRedownload(
  dataDir: string,
  opts: { probe?: CoreVersionProbe } = {},
): Promise<{ version: string; removedRecord: boolean; removedBinary: boolean }> {
  const root = resolve(dataDir, "core");
  let version = BUNDLED_CORE_VERSION;
  try {
    const active = JSON.parse(await readFile(join(root, "active.json"), "utf8")) as { version?: unknown };
    if (typeof active?.version === "string" && /^\d+\.\d+\.\d+$/.test(active.version)) version = active.version;
  } catch { /* no active.json: the bundled version */ }
  const versionDir = join(root, "versions", version);
  const record = join(versionDir, "verified.json");
  const binary = join(versionDir, bundledCoreFileName());
  let removedRecord = false;
  let removedBinary = false;
  try {
    await stat(record);
    await rm(record, { force: true });
    removedRecord = true;
  } catch { /* none there */ }
  try {
    if ((await stat(binary)).isFile() && !(await coreBinaryRuns(binary, version, opts.probe)).ok) {
      await rm(binary, { force: true });
      removedBinary = true;
    }
  } catch { /* no binary, or it could not be removed (running): the agent's install says so */ }
  return { version, removedRecord, removedBinary };
}
