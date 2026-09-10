import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { restrictWindowsAcl } from "../config/windows-acl.js";
import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  setDotenvKey,
  writeUserConfigFileSync,
  type AtomicMailConfig,
} from "../config/index.js";
import type { AtomicMailSession } from "./atomic-mail-client.js";

/**
 * Where the agent's inbox lives on disk, split the way every other
 * integration is: the API key in `<stateDir>/.env`, the non-secret
 * facts in `config.json`, and the hour-long session token in its own
 * 0600 file so a send inside the hour costs no proof-of-work.
 */
export const ATOMIC_MAIL_API_KEY_KEY = "ATOMIC_MAIL_API_KEY";

export function readAtomicMailApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[ATOMIC_MAIL_API_KEY_KEY];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function writeAtomicMailApiKey(
  stateDir: string,
  apiKey: string | null,
): void {
  setDotenvKey(stateDir, ATOMIC_MAIL_API_KEY_KEY, apiKey);
  if (apiKey === null) delete process.env[ATOMIC_MAIL_API_KEY_KEY];
  else process.env[ATOMIC_MAIL_API_KEY_KEY] = apiKey;
}

export function resolveSessionPath(stateDir: string): string {
  return join(stateDir, "atomic-mail", "session.json");
}

export function readCachedSession(stateDir: string): AtomicMailSession | null {
  try {
    const raw = JSON.parse(
      readFileSync(resolveSessionPath(stateDir), "utf-8"),
    ) as Partial<AtomicMailSession>;
    if (
      typeof raw.sessionJwt !== "string" ||
      typeof raw.sessionExpiresAt !== "number"
    )
      return null;
    return {
      sessionJwt: raw.sessionJwt,
      sessionExpiresAt: raw.sessionExpiresAt,
    };
  } catch {
    return null;
  }
}

export function writeCachedSession(
  stateDir: string,
  session: AtomicMailSession | null,
): void {
  const path = resolveSessionPath(stateDir);
  if (session === null) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* ignore */
    }
    return;
  }
  mkdirSync(join(stateDir, "atomic-mail"), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(session), {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows: mode bits mean nothing there */
  }
  if (process.platform === "win32") restrictWindowsAcl(path);
}

/** Merge a patch into `config.json`'s `atomicMail` block. */
export function persistAtomicMailConfig(
  patch: Partial<AtomicMailConfig>,
): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = { ...prev, atomicMail: { ...prev.atomicMail, ...patch } };
  writeUserConfigFileSync(path, parseUserConfigFile(draft));
  resetConfigCache();
}
