import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { restrictWindowsAcl } from "../../config/windows-acl.js";
import { resolveApiKeyFilePath } from "../backend-paths.js";

/**
 * The bearer key a managed `llama-server` is launched with (issue #582).
 *
 * Without a key llama-server answers every origin (`CORS: *`), so any web
 * page open in a local browser could drive the model through
 * `fetch("http://127.0.0.1:19091/…")`. A page cannot know a key that
 * lives only in a 0600 file, so the key alone closes that door.
 *
 * The key is persisted next to the daemon's pid file rather than held in
 * memory: the daemon outlives the process that started it and is reused
 * by every later one (the TUI after `models start`, a restarted TUI, the
 * sidecar), and each of them has to send the same key. Generated once,
 * then reused for as long as the file holds a usable key; a file that
 * does not (empty, truncated, hand-edited) is replaced with a fresh one.
 *
 * It reaches the server through the `LLAMA_API_KEY` environment variable
 * of the spawned process (`--api-key`'s env binding), never argv: argv is
 * visible in `ps` and in a spawn error's `spawnargs`, and `--api-key-file`
 * is opened by llama.cpp with a plain `std::ifstream`, which a Windows
 * profile path outside the ANSI code page would fail to open.
 */

const SECRET_FILE_MODE = 0o600;

/** The env var llama-server reads `--api-key` from. */
export const LLAMA_API_KEY_ENV = "LLAMA_API_KEY";

/** A key llama-server accepts verbatim: `--api-key` splits on commas. */
function isUsableKey(key: string): boolean {
  return key.length > 0 && !/[\s,]/.test(key);
}

/**
 * What is on disk: no file, a file that could not be read (mode 000, a
 * Windows sharing violation, an ACL), or its contents, `key: null` when
 * they hold no usable key.
 */
type KeyFile =
  | { state: "missing" }
  | { state: "unreadable" }
  | { state: "read"; key: string | null };

function readKeyFile(dataDir: string): KeyFile {
  try {
    const key = readFileSync(resolveApiKeyFilePath(dataDir), "utf-8").trim();
    return { state: "read", key: isUsableKey(key) ? key : null };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "unreadable" };
  }
}

/** The persisted key, or `null` when there is none (or it is unreadable). */
export function readManagedApiKey(dataDir: string): string | null {
  const file = readKeyFile(dataDir);
  return file.state === "read" ? file.key : null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read a key another process is creating: on a filesystem without hard
 * links the file exists (exclusive create) a moment before its bytes do,
 * so an empty read means "not written yet", not "no key".
 */
function readWrittenKey(dataDir: string): string | null {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const key = readManagedApiKey(dataDir);
    if (key) return key;
    if (!existsSync(resolveApiKeyFilePath(dataDir))) return null;
    sleepSync(10);
  }
  return null;
}

/**
 * The persisted key, generating it on first use. Two processes racing
 * here agree on one key: the new key is written to a private temp file
 * and hard-linked into place, which fails for the loser, who then reads
 * the winner's. Best-effort: when the file cannot be written (read-only
 * data dir) this returns `null` and the launch stays as unprotected as
 * it was before, rather than failing.
 */
export function ensureManagedApiKey(dataDir: string): string | null {
  const path = resolveApiKeyFilePath(dataDir);
  let file = readKeyFile(dataDir);
  if (file.state === "unreadable") {
    // The key may be fine and a running daemon may hold it: restore the
    // owner's read bit and look again, but never overwrite a key that
    // could not be read.
    try {
      chmodSync(path, SECRET_FILE_MODE);
    } catch {
      /* not ours to change */
    }
    file = readKeyFile(dataDir);
    if (file.state === "unreadable") return null;
  }
  if (file.state === "read") {
    // Present but not a key: give a racing writer the usual grace, then
    // replace what is still unusable instead of launching keyless.
    return file.key ?? readWrittenKey(dataDir) ?? replaceUnusableKey(dataDir);
  }
  const key = randomBytes(32).toString("hex");
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, `${key}\n`, { encoding: "utf-8", mode: SECRET_FILE_MODE });
    try {
      linkSync(tmp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // No hard links on this filesystem: exclusive create instead.
        writeFileSync(path, `${key}\n`, {
          encoding: "utf-8",
          mode: SECRET_FILE_MODE,
          flag: "wx",
        });
      }
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* already gone */
      }
    }
  } catch {
    // Lost an exclusive-create race, or the directory is not writable:
    // whatever is on disk now is the answer.
    return readWrittenKey(dataDir);
  }
  try {
    chmodSync(path, SECRET_FILE_MODE);
  } catch {
    /* best-effort on Windows */
  }
  restrictWindowsAcl(path);
  return readWrittenKey(dataDir);
}

/**
 * A heal lock older than this is stale even when its pid looks alive (the
 * pid may have been reused). A dead holder's lock is stale at once.
 */
const HEAL_LOCK_STALE_MS = 3_000;

function healLockPath(dataDir: string): string {
  return `${resolveApiKeyFilePath(dataDir)}.heal-lock`;
}

/** `false` only when the pid in the lock (`<pid> <token>`) is gone. */
function lockHolderAlive(contents: string): boolean {
  const pid = Number.parseInt(contents, 10);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The lock's contents when it is stale, `null` when it is live or gone. */
function staleLockContents(lock: string): string | null {
  try {
    const contents = readFileSync(lock, "utf-8");
    const old = Date.now() - statSync(lock).mtimeMs >= HEAL_LOCK_STALE_MS;
    return old || !lockHolderAlive(contents) ? contents : null;
  } catch {
    return null;
  }
}

/**
 * Remove the lock only if it still holds `contents`. It is renamed to a
 * unique name first, so of two processes doing this only one gets it; a
 * lock that turns out to be someone else's is linked back into place
 * (unless a newer one already took it).
 */
function removeLockIfHolds(lock: string, contents: string): boolean {
  const grave = `${lock}.${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lock, grave);
  } catch {
    return false;
  }
  let ours = false;
  try {
    ours = readFileSync(grave, "utf-8") === contents;
    if (!ours) linkSync(grave, lock);
  } catch {
    /* a newer lock is in place */
  }
  try {
    unlinkSync(grave);
  } catch {
    /* already gone */
  }
  return ours;
}

/** Exclusively create the heal lock: its contents, or `null` when held. */
function tryTakeHealLock(dataDir: string): string | null {
  const lock = healLockPath(dataDir);
  const contents = `${process.pid} ${randomBytes(8).toString("hex")}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lock, contents, { encoding: "utf-8", flag: "wx" });
      return contents;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null;
    }
    const stale = staleLockContents(lock);
    if (stale === null || !removeLockIfHolds(lock, stale)) {
      if (existsSync(lock)) return null;
    }
  }
  return null;
}

/**
 * Wait for the lock holder's key. The holder may run `icacls` on Windows,
 * which takes far longer than the create path's grace, so wait while the
 * lock is live rather than a fixed 200ms; stop early once it is released
 * or its holder has died.
 */
function waitForHealedKey(dataDir: string): string | null {
  const lock = healLockPath(dataDir);
  const deadline = Date.now() + HEAL_LOCK_STALE_MS;
  while (Date.now() < deadline) {
    const key = readManagedApiKey(dataDir);
    if (key) return key;
    if (!existsSync(lock) || staleLockContents(lock) !== null) break;
    sleepSync(25);
  }
  return readManagedApiKey(dataDir);
}

function releaseHealLock(dataDir: string, contents: string): void {
  removeLockIfHolds(healLockPath(dataDir), contents);
}

/** Windows refuses to replace a file another process (an AV scan) has open. */
function renameOverSync(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (process.platform !== "win32" || !transient || attempt >= 4) throw err;
      sleepSync(25);
    }
  }
}

/**
 * Overwrite a key file that exists but holds no usable key (empty,
 * whitespace, a value with commas) with a fresh one. Healers take a lock
 * and re-read under it, so two processes healing at once agree on one
 * key: the second finds the first one's key and keeps it. A process that
 * cannot take the lock waits for the holder's key. The new key is written
 * to a private temp file (0600, and the restricted ACL on Windows) and
 * renamed over the old one, so a reader never sees a half-written file.
 */
function replaceUnusableKey(dataDir: string, waited = false): string | null {
  const lock = tryTakeHealLock(dataDir);
  if (!lock) {
    if (waited) return readManagedApiKey(dataDir);
    // Holder gone or done without a key: take the (now stale) lock and heal.
    return waitForHealedKey(dataDir) ?? replaceUnusableKey(dataDir, true);
  }
  try {
    const file = readKeyFile(dataDir);
    if (file.state === "read" && file.key) return file.key;
    if (file.state === "unreadable") return null;
    const path = resolveApiKeyFilePath(dataDir);
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      writeFileSync(tmp, `${randomBytes(32).toString("hex")}\n`, {
        encoding: "utf-8",
        mode: SECRET_FILE_MODE,
      });
      restrictWindowsAcl(tmp);
      renameOverSync(tmp, path);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        /* never created */
      }
      return readManagedApiKey(dataDir);
    }
    try {
      chmodSync(path, SECRET_FILE_MODE);
    } catch {
      /* best-effort on Windows */
    }
    return readManagedApiKey(dataDir);
  } finally {
    releaseHealLock(dataDir, lock);
  }
}

/**
 * The key a daemon in `dataDir` is launched with. `configuredKey` is
 * `localModels.apiKey` — the key every client of the daemon sends — so
 * the server is started with exactly that key. With none configured the
 * persisted key is used (generated on first launch).
 */
export function resolveManagedServerApiKey(
  dataDir: string,
  configuredKey: string | null,
): string | null {
  return configuredKey || ensureManagedApiKey(dataDir);
}

/**
 * The environment a managed daemon is spawned with: the parent's, with
 * `LLAMA_API_KEY` set to `apiKey`. The variable is set on the child's
 * copy only, never on `process.env`, so nothing else the agent spawns
 * inherits it. With no key the parent's environment passes unchanged.
 */
export function buildDaemonEnv(
  apiKey: string | null,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return apiKey ? { ...base, [LLAMA_API_KEY_ENV]: apiKey } : { ...base };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True when `url` is a loopback address on one of `ports`. */
export function isLoopbackUrlOnPort(
  url: string | null | undefined,
  ports: readonly number[],
): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const loopback = LOOPBACK_HOSTS.has(host) || /^127(\.\d{1,3}){3}$/.test(host);
    return loopback && ports.map(String).includes(parsed.port);
  } catch {
    return false;
  }
}

export interface LocalLlamaApiKeyInputs {
  /** `ATOMIC_AGENT_LLAMA_API_KEY`, when set. */
  envKey: string | undefined;
  mode: "managed" | "external";
  /** `localModels.url` — the server this key is sent to. */
  chatUrl: string;
  /** `localModels.managed.port` and `localModels.embeddings.port`. */
  managedPorts: readonly number[];
  /** Where the managed daemons keep their pid files (and the key). */
  dataDir: string;
}

/**
 * `localModels.apiKey`: the key every client of the local llama-server
 * sends. The operator's key wins. Otherwise the managed daemons' key
 * whenever the agent talks to them: in managed mode, and in external mode
 * when the chat URL is a managed port on loopback — the documented way to
 * drive a daemon started with `atomic-agent models start`, which launches with
 * the same key whatever the mode. The key is generated there too rather
 * than only read, so a process that loads its config before the daemon's
 * first launch (in another process) already holds the key that launch
 * will use. Any other external server gets no key it was not given.
 */
export function resolveLocalLlamaApiKey(inputs: LocalLlamaApiKeyInputs): string | null {
  if (inputs.envKey) return inputs.envKey;
  const talksToManagedDaemon =
    inputs.mode === "managed" ||
    isLoopbackUrlOnPort(inputs.chatUrl, inputs.managedPorts);
  return talksToManagedDaemon ? ensureManagedApiKey(inputs.dataDir) : null;
}

/**
 * The key the embedding client sends to `embeddingsUrl`. `localModels.apiKey`
 * is resolved for the chat URL; an external-mode chat server elsewhere
 * leaves it `null` while the embeddings may still go to the managed
 * embedding daemon, which requires the persisted key. Read, not created:
 * a daemon that was launched has already written it.
 */
export function resolveEmbeddingApiKey(inputs: {
  configuredKey: string | null;
  embeddingsUrl: string;
  managedPorts: readonly number[];
  dataDir: string;
}): string | null {
  if (inputs.configuredKey) return inputs.configuredKey;
  return isLoopbackUrlOnPort(inputs.embeddingsUrl, inputs.managedPorts)
    ? readManagedApiKey(inputs.dataDir)
    : null;
}

/** The env var an operator sets to give every local llama-server client a key. */
export const OPERATOR_LLAMA_API_KEY_ENV = "ATOMIC_AGENT_LLAMA_API_KEY";

/** The parts of the live config `apiKeyForUrl` reads. */
export interface ApiKeyForUrlConfig {
  localModels: {
    url: string;
    apiKey: string | null;
    managed?: { port: number };
    embeddings?: { port: number };
  };
  paths?: { localModelsDataDir: string };
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The key to send to `url`, which may not be `localModels.url`: an
 * onboarding probe, a URL the operator is about to switch to, a provider
 * pinned to its own base. `localModels.apiKey` was resolved for the
 * configured URL only, and in managed mode it is the managed daemons' key,
 * which must never reach another host.
 *
 * - The operator's `ATOMIC_AGENT_LLAMA_API_KEY` goes wherever they point
 *   the agent, as it always has.
 * - For the configured URL itself, `localModels.apiKey` (resolved for it).
 * - The managed daemons' key only for a managed port on loopback.
 * - Anything else gets no key.
 */
export function apiKeyForUrl(
  url: string,
  config: ApiKeyForUrlConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const envKey = env[OPERATOR_LLAMA_API_KEY_ENV];
  if (envKey) return envKey;
  if (stripTrailingSlashes(url) === stripTrailingSlashes(config.localModels.url)) {
    return config.localModels.apiKey;
  }
  const managedPorts = [
    config.localModels.managed?.port,
    config.localModels.embeddings?.port,
  ].filter((port): port is number => typeof port === "number");
  if (!isLoopbackUrlOnPort(url, managedPorts)) return null;
  if (config.localModels.apiKey) return config.localModels.apiKey;
  const dataDir = config.paths?.localModelsDataDir;
  return dataDir ? readManagedApiKey(dataDir) : null;
}
