/**
 * ATO-2796: the agent's own key and trust files, which an `@file` mention
 * never inlines. Core refuses them in `src/mentions/` (`getStateSecretPaths`
 * in src/config/config-file.ts, checked by real path in mention-services.ts);
 * this is the same list and the same check for the desktop's own fallback
 * (file-mentions.ts, used when the agent is too old for
 * `/api/mentions/expand` or does not answer). Without it, a chat whose
 * working folder is the agent's state folder (`~/.atomic-agent`) sent
 * `@.env` or `@config.json` to the model in full.
 *
 * The names are spelled here because the desktop cannot import core;
 * mention-state-secrets.test.mjs pins them. Folder entries of the core list
 * that hold code (`plugins/installed/`, `logbook/`) are not refused there
 * either, so they are left out here. The sign-in folders
 * (`getStateSecretDirectories`: `auth/`, `mcp-oauth/`, `whatsapp-auth/`)
 * are refused with every file in them (`stateSecretFolders`).
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

import { managedSideFromFile } from "./local-llama-key.js";
import { DESKTOP_STATE_DIR } from "./state-dir.js";

/** True for a file (given by its real path) that is never inlined. */
export type IsProtectedPath = (real: string) => boolean;

/** `getStateSecretPaths` for `stateDir`, files only, in the same order. */
export function stateSecretFiles(stateDir: string, modelsDir: string, home: string = homedir()): string[] {
  return [
    join(stateDir, "config.json"),
    join(stateDir, ".env"),
    join(stateDir, "secrets-store.json"),
    join(stateDir, "secret-sources.json"),
    join(stateDir, "approval-rules.json"),
    join(stateDir, "hooks.json"),
    join(stateDir, "guard.md"),
    join(stateDir, "plugins", "plugins.json"),
    join(stateDir, "plugins", "marketplaces.json"),
    join(home, ".curlrc"),
    join(home, ".wgetrc"),
    join(stateDir, "pr-autofix", "state.json"),
    join(modelsDir, "llama-server.key"),
    join(stateDir, "serve-api.key"),
    join(stateDir, "model-share.key"),
    join(modelsDir, "core", "chat.json"),
    join(modelsDir, "core", "embedding.json"),
    join(stateDir, "atomic-mail", "session.json"),
    join(stateDir, "http-devices.json"),
    // ATO-2496: the token hashes `atomic-agent serve` lets callers in with.
    join(stateDir, "http-tokens.json"),
    // ATO-2451: the lasting `atag launch --config` token (core's launchClientKeyPath).
    join(stateDir, "launch-client.key"),
  ];
}

/**
 * Core's `getStateSecretDirectories` for `stateDir`: folders whose every
 * file is a sign-in (subscription tokens, MCP sign-ins, WhatsApp keys).
 */
export function stateSecretFolders(stateDir: string): string[] {
  return [join(stateDir, "auth"), join(stateDir, "mcp-oauth"), join(stateDir, "whatsapp-auth")];
}

/**
 * A file's real path, also when it does not exist yet: the real path of the
 * nearest folder that does, plus the rest. A state folder reached through a
 * symlink (macOS `/var` is `/private/var`) still matches.
 */
function canonicalOf(path: string): string {
  try {
    // The native realpath gives the spelling on disk (core's canonicalOf).
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonicalOf(parent), basename(path));
  }
}

/**
 * A check against `files` by real path (core's `protectedPathCheck`), and
 * against anything inside `folders`. Case is folded on Windows and macOS,
 * whose default volumes ignore it, so `@.ENV` is refused too.
 */
export function protectedPathCheck(
  files: readonly string[],
  platform: NodeJS.Platform = process.platform,
  folders: readonly string[] = [],
): IsProtectedPath {
  const fold = (p: string): string => (platform === "win32" || platform === "darwin" ? p.toLowerCase() : p);
  const set = new Set(files.map((f) => fold(canonicalOf(f))));
  const prefixes = folders.map((f) => fold(canonicalOf(f)).replace(/[\\/]+$/, "") + sep);
  return (real) => {
    const path = fold(canonicalOf(real));
    return set.has(path) || prefixes.some((prefix) => path.startsWith(prefix));
  };
}

/**
 * The check for this desktop's state folder, built per call: the files can
 * appear after start, and the models folder follows `config.json`.
 */
export const isAgentStateSecret: IsProtectedPath = (real) => {
  let modelsDir: string;
  try {
    modelsDir = managedSideFromFile().dataDir;
  } catch {
    modelsDir = join(DESKTOP_STATE_DIR, "models");
  }
  return protectedPathCheck(
    stateSecretFiles(DESKTOP_STATE_DIR, modelsDir),
    process.platform,
    stateSecretFolders(DESKTOP_STATE_DIR),
  )(real);
};
