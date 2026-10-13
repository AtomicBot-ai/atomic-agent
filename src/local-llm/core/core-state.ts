import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { restrictWindowsAcl } from "../../config/windows-acl.js";

export type ManagedEngine = "llama-server" | "atomic-core";
/**
 * Exact releases exercised by the host's control-contract tests. The last
 * one is what this build installs; older entries stay readable so an
 * existing install, its sessions and its daemon still stop cleanly.
 */
export const CORE_VERSIONS = ["0.11.2", "0.13.6"] as const;
export const CORE_VERSION = CORE_VERSIONS[CORE_VERSIONS.length - 1]!;
export const CORE_PROTOCOL = 2;
export const CORE_REPO = "AtomicBot-ai/atomic-chat-core";

// The failure text lives with the structured error; re-exported for existing importers.
export { CORE_RETRY_HINT, CoreUnavailableError } from "./core-errors.js";

export interface CoreBackend {
  coreVersion: string;
  provider: "llamacpp";
  version: string;
  backend: string;
  binary: string;
  installedAt: string;
}
export interface CoreSession {
  pid: number;
  port: number;
  model_id: string;
  model_path: string;
  api_key: string;
  is_embedding: boolean;
  provider: string;
  generation?: string;
  /**
   * The projector the session was loaded with. Core 0.13 reports `null`
   * when it had to retry the load without it; older releases omit it.
   */
  mmproj_path?: string | null;
}
export interface CoreSessionRecord extends CoreSession {
  coreVersion: string;
  instanceId: string;
}
export function coreRoot(dataDir: string): string { return resolve(dataDir, "core"); }
export function coreVersionDir(dataDir: string, version: string): string {
  if (!CORE_VERSIONS.includes(version as typeof CORE_VERSIONS[number])) {
    throw new Error(`Atomic Core ${version} is not supported by this Agent build. Update Agent first.`);
  }
  return join(coreRoot(dataDir), "versions", version);
}
export function coreDataDir(dataDir: string, version: string): string {
  return join(coreVersionDir(dataDir, version), "data");
}
export function coreBinary(dataDir: string, version: string): string {
  return join(coreVersionDir(dataDir, version), process.platform === "win32" ? "atomic-chat-core.exe" : "atomic-chat-core");
}
export function readCoreJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}
export function writeCoreJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  restrictWindowsAcl(tmp);
  renameSync(tmp, path);
}
export function activeCoreVersion(dataDir: string): string {
  const stored = readCoreJson<{ version?: string }>(join(coreRoot(dataDir), "active.json"))?.version;
  return stored && CORE_VERSIONS.includes(stored as typeof CORE_VERSIONS[number]) ? stored : CORE_VERSION;
}
/** The backend Core installed for `version` (default: the active one). */
export function readCoreBackend(dataDir: string, version = activeCoreVersion(dataDir)): CoreBackend | null {
  const record = readCoreJson<CoreBackend>(join(coreVersionDir(dataDir, version), "backend.json"));
  return record?.coreVersion === version && typeof record.binary === "string" && existsSync(record.binary) ? record : null;
}
export function coreSessionPath(dataDir: string, role: "chat" | "embedding"): string {
  return join(coreRoot(dataDir), `${role}.json`);
}
function readSessionRecord(dataDir: string, role: "chat" | "embedding"): CoreSessionRecord | null {
  const record = readCoreJson<CoreSessionRecord>(coreSessionPath(dataDir, role));
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0 || !Number.isInteger(record.port) ||
      record.port <= 0 || record.port > 65535 || typeof record.api_key !== "string" || !record.api_key) return null;
  if (!CORE_VERSIONS.includes(record.coreVersion as typeof CORE_VERSIONS[number])) return null;
  return record;
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
/** The Core daemon that owns `version`'s data folder, when one is ready and alive. */
function liveCoreOwner(dataDir: string, version: string): { instanceId: string } | null {
  const lock = readCoreJson<{ instance_id?: string; state?: string; pid?: number }>(join(coreDataDir(dataDir, version), "atomic-core", "instance.lock"));
  if (lock?.state !== "ready" || typeof lock.instance_id !== "string" || !Number.isInteger(lock.pid) || lock.pid! < 1) return null;
  return pidAlive(lock.pid!) ? { instanceId: lock.instance_id } : null;
}
export function readCoreSession(dataDir: string, role: "chat" | "embedding"): CoreSessionRecord | null {
  const record = readSessionRecord(dataDir, role);
  if (!record) return null;
  if (liveCoreOwner(dataDir, record.coreVersion)?.instanceId !== record.instanceId) return null;
  return pidAlive(record.pid) ? record : null;
}
/**
 * A session whose Core died while its llama-server lives on (Core crashed):
 * no Core of that version is running, but the recorded model process is.
 * A Core that is running under another instance has already reaped what it
 * could, so its records are not orphans, only stale.
 */
export function orphanedCoreSession(dataDir: string, role: "chat" | "embedding"): CoreSessionRecord | null {
  const record = readSessionRecord(dataDir, role);
  if (!record || liveCoreOwner(dataDir, record.coreVersion)) return null;
  return pidAlive(record.pid) ? record : null;
}
/** Session secrets never follow a configured URL to a remote host. */
export function coreKeyForUrl(dataDir: string, url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) return null;
  for (const role of ["chat", "embedding"] as const) {
    // An orphaned session still checks its own key until it is recovered.
    const record = readCoreSession(dataDir, role) ?? orphanedCoreSession(dataDir, role);
    if (record && String(record.port) === parsed.port) return record.api_key;
  }
  return null;
}
