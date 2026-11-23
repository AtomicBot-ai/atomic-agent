import { chmodSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  OWNER_ONLY_FILE_MODE,
  writeOwnerOnlyFileAtomicSync,
} from "../../../config/owner-only-file.js";
import type { OAuthTokens, TokenStore } from "./oauth-types.js";

/**
 * ATO-1449: where subscription sign-in tokens live on disk.
 *
 * One file per service under `<stateDir>/auth/` (`auth/chatgpt.json`),
 * never in `config.json`: the config is read, printed and exported by
 * many paths (`atag config`, `doctor`, `share`, the desktop's settings),
 * the token file by this module only.
 *
 * Written through `writeOwnerOnlyFileAtomicSync`, so the file is 0600
 * on macOS and Linux and narrowed to the owner's ACL on Windows, and a
 * crash mid-write never leaves half a file. A file found with a wider
 * mode (copied by hand, restored from a backup) is tightened on read,
 * with a warning, before its contents are used.
 */

/** `<stateDir>/auth`, created 0700 on first write. */
export function subscriptionAuthDir(stateDir: string): string {
  return join(stateDir, "auth");
}

/** `<stateDir>/auth/<service>.json`. */
export function subscriptionTokenPath(stateDir: string, service: string): string {
  return join(subscriptionAuthDir(stateDir), `${service}.json`);
}

/** On-disk shape. Versioned so a later build can migrate it. */
interface StoredFile {
  version: 1;
  tokens: OAuthTokens;
  /** Epoch ms of the last write; shown by status commands, never a secret. */
  savedAt: number;
}

export interface FileTokenStoreOptions {
  path: string;
  /** Told when a wider-than-0600 file was tightened. Never gets token text. */
  onWarning?: (message: string) => void;
  now?: () => number;
}

export interface FileTokenStore extends TokenStore {
  readonly path: string;
  /** When the tokens were last written, or null when signed out. */
  savedAt(): number | null;
}

/** File-backed `TokenStore` for the OAuth primitives. */
export function createFileTokenStore(options: FileTokenStoreOptions): FileTokenStore {
  const now = options.now ?? Date.now;
  const path = options.path;

  function readFile(): StoredFile | null {
    let raw: string;
    try {
      tightenIfTooOpen(path, options.onWarning);
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if (isMissing(err)) return null;
      throw new Error(`Cannot read the sign-in file ${path}`);
    }
    return parseStoredFile(raw);
  }

  return {
    path,
    async load() {
      return readFile()?.tokens ?? null;
    },
    async save(tokens) {
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(dir, 0o700);
      } catch {
        // Windows: no POSIX modes; the file's own ACL is narrowed below.
      }
      const file: StoredFile = { version: 1, tokens: pickTokenFields(tokens), savedAt: now() };
      writeOwnerOnlyFileAtomicSync(path, `${JSON.stringify(file, null, 2)}\n`);
    },
    async clear() {
      try {
        unlinkSync(path);
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    },
    savedAt() {
      try {
        return readFile()?.savedAt ?? null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Keeps the known fields only, so nothing the server added (or a test
 * double carried) is written beside the tokens.
 */
function pickTokenFields(tokens: OAuthTokens): OAuthTokens {
  const out: OAuthTokens = { accessToken: tokens.accessToken };
  if (tokens.refreshToken !== undefined) out.refreshToken = tokens.refreshToken;
  if (tokens.idToken !== undefined) out.idToken = tokens.idToken;
  if (tokens.tokenType !== undefined) out.tokenType = tokens.tokenType;
  if (tokens.scope !== undefined) out.scope = tokens.scope;
  if (tokens.expiresAt !== undefined) out.expiresAt = tokens.expiresAt;
  return out;
}

/** A file this module cannot read reads as signed out, never as a crash. */
function parseStoredFile(raw: string): StoredFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const tokens = obj.tokens as Record<string, unknown> | undefined;
  if (obj.version !== 1 || typeof tokens !== "object" || tokens === null) return null;
  if (typeof tokens.accessToken !== "string" || tokens.accessToken.length === 0) return null;
  const out: OAuthTokens = { accessToken: tokens.accessToken };
  for (const key of ["refreshToken", "idToken", "tokenType", "scope"] as const) {
    const value = tokens[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  if (typeof tokens.expiresAt === "number" && Number.isFinite(tokens.expiresAt)) {
    out.expiresAt = tokens.expiresAt;
  }
  const savedAt = typeof obj.savedAt === "number" ? obj.savedAt : 0;
  return { version: 1, tokens: out, savedAt };
}

/** 0600 or tighter is fine; anything group/other can touch is narrowed. */
function tightenIfTooOpen(path: string, onWarning?: (message: string) => void): void {
  if (process.platform === "win32") return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) === 0) return;
  chmodSync(path, OWNER_ONLY_FILE_MODE);
  onWarning?.(
    `The sign-in file ${path} was readable by other accounts (mode ${mode.toString(8)}); it is now owner-only (600).`,
  );
}

function isMissing(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ENOENT";
}
