/**
 * Studio: find, start and hold Atomic Chat Core the way the agent does, so
 * the desktop and an agent (TUI, `atag serve`) share one Core daemon.
 *
 * Mirrors, by file layout and protocol rather than by import (the desktop
 * is a separate build):
 *   - src/local-llm/core/core-state.ts   `<dataDir>/core/versions/<v>/data`,
 *     the binary beside it, protocol 2;
 *   - src/local-llm/core/core-client.ts  `connectCore` (instance.lock +
 *     control-token, then `/snapshot` checked), `startCore` (detached
 *     `daemon --data-folder … --control-port 0 --telemetry off`),
 *     `acquireCoreLease` (`POST /clients` + heartbeats);
 *   - src/local-llm/core/core-operation.ts  the engine operation lock
 *     (`<dataDir>/core/operation.lock`, guarded by `operation-gate.lock`),
 *     so a Studio start never races a model load in another window;
 *   - src/local-llm/core/core-env.ts  no secret-shaped variable reaches the
 *     daemon: provider keys go to Core only through `PUT /cloud/providers`.
 *
 * The binary is normally put in place by core-seed.ts (bundled) or by the
 * agent's own install. When neither has (a cloud-route install that never
 * started a local model, a dev run, a failed seed), `ensureStudioCore` seeds
 * the bundled copy if there is one, else downloads and verifies Core the way
 * the agent's image tool does (studio-core-install.ts), under the same
 * operation lock.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { CoreSeedResult } from "./core-seed.js";
import { StudioCoreClient, StudioCoreError } from "./studio-core-client.js";
import { installStudioCore, isStudioCoreInstalled, type CoreInstallProgress, type StudioCoreInstallOptions } from "./studio-core-install.js";

export const CORE_PROTOCOL = 2;

export interface StudioCorePaths {
  root: string;
  versionDir: string;
  dataFolder: string;
  lock: string;
  token: string;
  binary: string;
  log: string;
}

export function studioCorePaths(dataDir: string, version: string, platform: NodeJS.Platform = process.platform): StudioCorePaths {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a Core version: ${version}`);
  const root = resolve(dataDir, "core");
  const versionDir = join(root, "versions", version);
  const dataFolder = join(versionDir, "data");
  return {
    root,
    versionDir,
    dataFolder,
    lock: join(dataFolder, "atomic-core", "instance.lock"),
    token: join(dataFolder, "atomic-core", "control-token"),
    binary: join(versionDir, platform === "win32" ? "atomic-chat-core.exe" : "atomic-chat-core"),
    log: join(versionDir, "core.log"),
  };
}

const KNOWN_SECRET_VARS = new Set([
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ATOMIC_AGENT_OPENAI_API_KEY", "OPENROUTER_API_KEY",
  "GEMINI_API_KEY", "OLLAMA_API_KEY", "OLLAMA_CLOUD_API_KEY", "ATOMIC_CHAT_API_KEY", "AIMLAPI_API_KEY",
  "EXA_API_KEY", "LLAMA_API_KEY", "ATOMIC_AGENT_LLAMA_API_KEY", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN",
  "GITHUB_TOKEN", "GH_TOKEN", "COMPOSIO_API_KEY",
]);
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE/i;

/** The daemon's environment: everything but secret-shaped names, telemetry off. */
export function studioCoreEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !KNOWN_SECRET_VARS.has(key.toUpperCase()) && !SECRET_NAME.test(key)) env[key] = value;
  }
  env.ATOMIC_CORE_TELEMETRY = "off";
  return env;
}

interface CoreLock {
  state?: string;
  instance_id?: string;
  control_host?: string;
  control_port?: number;
}

interface CoreSnapshot {
  instance_id: string;
  version: string;
  protocol: number;
  owner_scope: string;
  data_folder: string;
}

function samePath(a: string, b: string): boolean {
  const canonical = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  return a === b || canonical(a) === canonical(b);
}

/** A running Core of `version`, checked, or null when none is ready. Never starts one. */
export async function connectStudioCore(dataDir: string, version: string, request: typeof fetch = fetch): Promise<StudioCoreClient | null> {
  const paths = studioCorePaths(dataDir, version);
  let lock: CoreLock;
  try { lock = JSON.parse(readFileSync(paths.lock, "utf8")) as CoreLock; } catch { return null; }
  if (lock.state !== "ready") return null;
  const port = lock.control_port;
  if (lock.control_host !== "127.0.0.1" || !Number.isInteger(port) || port! < 1 || port! > 65535) {
    throw new StudioCoreError("Atomic Core supplied an invalid control address.", "CORE_INVALID");
  }
  let token: string;
  try { token = readFileSync(paths.token, "utf8").trim(); } catch { return null; }
  if (!token || /\s/.test(token)) throw new StudioCoreError("Atomic Core control credentials are invalid.", "CORE_INVALID");
  const client = new StudioCoreClient(`http://127.0.0.1:${port}`, token, version, lock.instance_id ?? "", request);
  let snap: CoreSnapshot;
  try { snap = await client.call<CoreSnapshot>("/snapshot"); } catch (err) {
    // A lock left behind by a Core that is gone: nothing is running.
    if (err instanceof StudioCoreError && err.code === "CORE_UNREACHABLE") return null;
    throw err;
  }
  if (snap.protocol !== CORE_PROTOCOL || snap.version !== version || snap.instance_id !== lock.instance_id ||
      snap.owner_scope !== "cli" || !samePath(snap.data_folder, paths.dataFolder)) {
    throw new StudioCoreError("Atomic Core version, protocol or ownership changed. Try again.", "CORE_MISMATCH");
  }
  return client;
}

/* ---- the engine operation lock (core-operation.ts), same files, same rules ---- */

class OperationBusy extends Error {}

function ownerIsDead(path: string): boolean {
  let pid: number;
  try { pid = Number(readFileSync(path, "utf8")); } catch { return false; }
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return false; } catch (err) { return (err as NodeJS.ErrnoException).code === "ESRCH"; }
}

function acquireOperation(root: string): () => void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "operation.lock");
  const gate = join(root, "operation-gate.lock");
  let gateFd: number;
  try { gateFd = openSync(gate, "wx", 0o600); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    if (ownerIsDead(gate)) throw new StudioCoreError(`Engine recovery was interrupted. With Atomic Agent closed, remove ${gate} and retry.`, "CORE_LOCK_STALE");
    throw new OperationBusy();
  }
  let fd: number;
  try {
    writeFileSync(gateFd, String(process.pid));
    try { fd = openSync(path, "wx", 0o600); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!ownerIsDead(path)) throw new OperationBusy();
      unlinkSync(path);
      fd = openSync(path, "wx", 0o600);
    }
    writeFileSync(fd, String(process.pid));
  } finally { closeSync(gateFd); unlinkSync(gate); }
  return () => { closeSync(fd); unlinkSync(path); };
}

/** Run `fn` holding the engine operation lock, waiting up to `waitMs` for another holder. */
export async function withStudioOperation<T>(dataDir: string, fn: () => Promise<T>, waitMs = 5 * 60_000): Promise<T> {
  const root = resolve(dataDir, "core");
  const deadline = Date.now() + waitMs;
  let release: () => void;
  for (;;) {
    try { release = acquireOperation(root); break; } catch (err) {
      if (!(err instanceof OperationBusy)) throw err;
      if (Date.now() >= deadline) throw new StudioCoreError("Another engine operation is still running. Try again in a moment.", "CORE_BUSY");
      await delay(250);
    }
  }
  try { return await fn(); } finally { release(); }
}

/** Studio's "Preparing the engine…" line while Core is being put in place (CONTRACT.md `core` event). */
export interface StudioCoreStatus {
  state: "installing" | "ready" | "failed";
  message: string;
  progress: CoreInstallProgress | null;
  error: { code: string; message: string } | null;
}

export interface EnsureStudioCoreOptions {
  signal?: AbortSignal;
  /** Place the installer's bundled Core (core-seed.ts seedBundledCore); absent outside a packaged app. */
  seed?: (dataDir: string) => Promise<CoreSeedResult>;
  /** Every step of an install, for the page's status line. Not called when Core was already there. */
  onStatus?: (status: StudioCoreStatus) => void;
  /** Test seams for the download (fetch, `--version` probe, platform). */
  install?: Omit<StudioCoreInstallOptions, "signal" | "onProgress">;
}

export const CORE_PREPARING = "Preparing the engine…";

/**
 * Core's binary for `version`, in place and verified: the bundled copy when
 * there is one, else the GitHub release. Call holding the operation lock.
 */
async function placeStudioCore(dataDir: string, version: string, opts: EnsureStudioCoreOptions): Promise<void> {
  const platform = opts.install?.platform ?? process.platform;
  if (await isStudioCoreInstalled(dataDir, version, platform)) return;
  const status = (s: Omit<StudioCoreStatus, "error"> & { error?: StudioCoreStatus["error"] }) => opts.onStatus?.({ error: null, ...s });
  status({ state: "installing", message: CORE_PREPARING, progress: null });
  try {
    const seeded = opts.seed ? await opts.seed(dataDir).catch(() => ({ seeded: false })) : { seeded: false };
    if (!seeded.seeded || !(await isStudioCoreInstalled(dataDir, version, platform))) {
      await installStudioCore(dataDir, version, {
        ...opts.install,
        ...(opts.signal ? { signal: opts.signal } : {}),
        onProgress: (progress) => status({ state: "installing", message: CORE_PREPARING, progress }),
      });
    }
  } catch (err) {
    if (opts.signal?.aborted) {
      status({ state: "failed", message: "Stopped.", progress: null, error: { code: "CANCELLED", message: "Stopped." } });
      throw err;
    }
    const reason = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
    const message = `Could not install the engine: ${reason}. Check your connection and try again.`;
    status({ state: "failed", message, progress: null, error: { code: "CORE_NOT_INSTALLED", message } });
    throw new StudioCoreError(message, "CORE_NOT_INSTALLED", undefined, reason);
  }
  status({ state: "ready", message: "The engine is ready.", progress: null });
}

/** A Core of `version` that answers: the running one, else one started now (installed first when missing). */
export async function ensureStudioCore(dataDir: string, version: string, opts: EnsureStudioCoreOptions = {}): Promise<StudioCoreClient> {
  const signal = opts.signal;
  const running = await connectStudioCore(dataDir, version);
  if (running) return running;
  return withStudioOperation(dataDir, async () => {
    const again = await connectStudioCore(dataDir, version);
    if (again) return again;
    const paths = studioCorePaths(dataDir, version);
    await placeStudioCore(dataDir, version, opts);
    if (!existsSync(paths.binary)) {
      throw new StudioCoreError("Could not install the engine: the engine file is missing after the install. Check your connection and try again.", "CORE_NOT_INSTALLED");
    }
    mkdirSync(paths.dataFolder, { recursive: true, mode: 0o700 });
    const log = openSync(paths.log, "a", 0o600);
    let spawnError: Error | undefined;
    try {
      const child = spawn(paths.binary, ["daemon", "--data-folder", paths.dataFolder, "--control-port", "0", "--telemetry", "off"], {
        detached: true, windowsHide: true, stdio: ["ignore", log, log], env: studioCoreEnv(),
      });
      child.once("error", (err) => { spawnError = err; });
      child.unref();
    } finally { closeSync(log); }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (spawnError) throw new StudioCoreError("Atomic Core could not be started.", "CORE_START_FAILED", undefined, spawnError.message);
      const client = await connectStudioCore(dataDir, version);
      if (client) return client;
      await delay(150);
    }
    throw new StudioCoreError("Atomic Core did not become ready in time.", "CORE_START_FAILED", undefined, `log: ${paths.log}`);
  });
}

/** A client lease: Core neither idles out nor counts itself unused while one is held. */
export interface StudioLease { id: string; release: () => Promise<void> }

export async function acquireStudioLease(client: StudioCoreClient): Promise<StudioLease> {
  const lease = await client.call<{ client: { id: string }; heartbeat_interval_ms: number }>("/clients", { name: "Atomic Agent Studio", pid: process.pid });
  const id = lease.client.id;
  const timer = setInterval(() => {
    void client.call(`/clients/${encodeURIComponent(id)}/heartbeat`, {}).catch(() => {});
  }, Math.max(1000, lease.heartbeat_interval_ms));
  timer.unref();
  return {
    id,
    release: async () => {
      clearInterval(timer);
      await client.call(`/clients/${encodeURIComponent(id)}`, undefined, { method: "DELETE" }).catch(() => {});
    },
  };
}
