import { randomBytes } from "node:crypto";
import {
  chmodSync,
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
 * Without `--api-key` llama-server answers every origin (`CORS: *`), so
 * any web page open in a local browser could drive the model through
 * `fetch("http://127.0.0.1:19091/…")`. A page cannot know a key that
 * lives only in a 0600 file, so the key alone closes that door.
 *
 * The key is persisted next to the daemon's pid file rather than held in
 * memory: the daemon outlives the process that started it and is reused
 * by every later one (the TUI after `models start`, a restarted TUI, the
 * sidecar), and each of them has to send the same key. Generated once,
 * then reused for as long as the file exists.
 */

const SECRET_FILE_MODE = 0o600;

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
    return readManagedApiKey(dataDir);
  }
  try {
    chmodSync(path, SECRET_FILE_MODE);
  } catch {
    /* best-effort on Windows */
  }
  restrictWindowsAcl(path);
  return readManagedApiKey(dataDir);
}

/** How a managed launch authenticates its clients. */
export interface ManagedServerAuth {
  /** The key clients must send; `null` leaves the server open. */
  apiKey: string | null;
  /**
   * The 0600 file holding exactly `apiKey`, passed as `--api-key-file`
   * so the key does not show up in the process list. Absent for a key
   * the operator set (`ATOMIC_AGENT_LLAMA_API_KEY`), which goes on
   * `--api-key`.
   */
  apiKeyFile?: string;
}

/**
 * The auth a daemon in `dataDir` is launched with. `configuredKey` is
 * `localModels.apiKey` — the key every client of the daemon sends — so
 * the server is started with exactly that key. With none configured the
 * persisted key is used (generated on first launch).
 */
export function resolveManagedServerAuth(
  dataDir: string,
  configuredKey: string | null,
): ManagedServerAuth {
  if (configuredKey) {
    return readManagedApiKey(dataDir) === configuredKey
      ? { apiKey: configuredKey, apiKeyFile: resolveApiKeyFilePath(dataDir) }
      : { apiKey: configuredKey };
  }
  const key = ensureManagedApiKey(dataDir);
  return key
    ? { apiKey: key, apiKeyFile: resolveApiKeyFilePath(dataDir) }
    : { apiKey: null };
}

/** The argv tail for `auth`; empty when the server stays open. */
export function buildApiKeyArgs(auth: ManagedServerAuth | undefined): string[] {
  if (!auth?.apiKey) return [];
  return auth.apiKeyFile
    ? ["--api-key-file", auth.apiKeyFile]
    : ["--api-key", auth.apiKey];
}
