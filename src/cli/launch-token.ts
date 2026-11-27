/**
 * ATO-2451: the key a launched CLI gets is a named serve token with the
 * `member` role (read + chat: the `/v1` and `/local/v1` routes), never
 * the serve key, which is `admin` and could change settings, skills and
 * MCP servers.
 *
 * - A run gets its own token, `launch-<cli>-<pid>-<random>`, made just
 *   before the CLI starts and removed when it exits, so two runs of the
 *   same CLI never share or revoke each other's. A run that died without
 *   cleaning up (SIGKILL, a crash) leaves its token behind; the next
 *   launch removes every `launch-*` token whose process is gone.
 * - `--config` needs one that lasts: `launch-config`, its value kept in
 *   `<stateDir>/launch-client.key` (0600; the token store keeps only a
 *   hash), printed by `atag launch --print-key` for Claude Code's
 *   `apiKeyHelper` and read by OpenCode through `{file:...}`. Remove it with
 *   `atag http tokens remove launch-config`; the next `--print-key` makes
 *   a new one.
 *
 * Serve reads the token file again whenever it changes, so a running
 * serve accepts a new token on its next request.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { restrictWindowsAcl } from "../config/windows-acl.js";
import {
  addHttpToken,
  hashHttpToken,
  readHttpTokens,
  removeHttpToken,
  removeHttpTokensWhere,
} from "../http/http-token-store.js";
import { readSecretKeyFile } from "../local-llm/server/managed-api-key.js";
import { isAlive } from "./serve-orphan-guard.js";

/** Role of every token launch makes. */
export const LAUNCH_TOKEN_ROLE = "member" as const;

export const LAUNCH_CONFIG_TOKEN_NAME = "launch-config";

export const LAUNCH_CLIENT_KEY_FILE = "launch-client.key";

const RUN_TOKEN = /^launch-[a-z0-9-]+?-(\d+)-[0-9a-f]{8}$/;

export function launchClientKeyPath(stateDir: string): string {
  return join(stateDir, LAUNCH_CLIENT_KEY_FILE);
}

/** The pid a per-run token name carries, or null for any other name. */
export function runTokenPid(name: string): number | null {
  const match = RUN_TOKEN.exec(name);
  return match ? Number(match[1]) : null;
}

export interface LaunchTokenDeps {
  readonly pid?: number;
  readonly isAlive?: (pid: number) => boolean;
}

export type IssuedToken = { readonly token: string; readonly revoke: () => void } | { readonly error: string };

/** A token for one run; `revoke` removes it (safe to call twice). */
export function issueRunToken(stateDir: string, cliId: string, deps: LaunchTokenDeps = {}): IssuedToken {
  const alive = deps.isAlive ?? isAlive;
  const pid = deps.pid ?? process.pid;
  removeHttpTokensWhere(stateDir, (t) => {
    const owner = runTokenPid(t.name);
    return owner !== null && owner !== pid && !alive(owner);
  });
  const name = `launch-${cliId}-${pid}-${randomBytes(4).toString("hex")}`;
  const added = addHttpToken(stateDir, name, LAUNCH_TOKEN_ROLE);
  if (!added.ok) return { error: added.error };
  let revoked = false;
  return {
    token: added.token,
    revoke: () => {
      if (revoked) return;
      revoked = true;
      removeHttpToken(stateDir, name);
    },
  };
}

/**
 * The lasting token of `--config`: the one in launch-client.key while the
 * store still has it under `launch-config`, else a new one (the old entry
 * replaced).
 */
export function lastingToken(stateDir: string): { readonly token: string } | { readonly error: string } {
  const path = launchClientKeyPath(stateDir);
  const kept = readSecretKeyFile(path);
  const tokens = readHttpTokens(stateDir);
  if (!tokens.ok) return { error: tokens.error };
  const entry = tokens.tokens.find((t) => t.name === LAUNCH_CONFIG_TOKEN_NAME);
  if (kept && entry && entry.sha256 === hashHttpToken(kept)) return { token: kept };
  if (entry) removeHttpToken(stateDir, LAUNCH_CONFIG_TOKEN_NAME);
  const added = addHttpToken(stateDir, LAUNCH_CONFIG_TOKEN_NAME, LAUNCH_TOKEN_ROLE);
  if (!added.ok) return { error: added.error };
  if (!writeOwnerOnly(path, added.token)) {
    removeHttpToken(stateDir, LAUNCH_CONFIG_TOKEN_NAME);
    return { error: `could not write ${path}` };
  }
  return { token: added.token };
}

/** Write `text` owner-only (0600, a restricted ACL on Windows) through a temp file. */
function writeOwnerOnly(path: string, text: string): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${text}\n`, { mode: 0o600 });
    restrictWindowsAcl(tmp);
    renameSync(tmp, path);
    return true;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}
