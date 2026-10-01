import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { restrictWindowsAcl } from "../config/windows-acl.js";
import { resolveApiKeyFilePath } from "./backend-paths.js";

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
 * then reused for as long as the file exists.
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

/** The persisted key, or `null` when there is none (or it is unreadable). */
export function readManagedApiKey(dataDir: string): string | null {
  try {
    const key = readFileSync(resolveApiKeyFilePath(dataDir), "utf-8").trim();
    return isUsableKey(key) ? key : null;
  } catch {
    return null;
  }
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
  const existing = readManagedApiKey(dataDir);
  if (existing) return existing;
  const path = resolveApiKeyFilePath(dataDir);
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
