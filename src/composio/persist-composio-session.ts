/**
 * Write the minted user id and cached tool-router session back to
 * `<stateDir>/config.json`.
 *
 * Follows `persistMcpServer`: re-validate the whole file through
 * `parseUserConfigFile` before writing, so a stale on-disk schema
 * cannot smuggle invalid state in on the back of this edit, then
 * drop the config cache so the next `getConfig()` sees the change.
 *
 * The API key is never touched here — it lives only in
 * `<stateDir>/.env`.
 */

import {
  ensureUserConfigFileSync,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";
import type { ComposioAccount } from "../config/composio-accounts-config.js";

export interface ComposioSessionRecord {
  userId: string;
  sessionId: string;
  mcpUrl: string;
  /** Stamp of the pins the session carries; `null` or absent = unpinned. */
  sessionPins?: string | null;
}

/** Persist the cached session and its pin stamp. Returns the path written. */
export function persistComposioSession(
  configPath: string,
  record: ComposioSessionRecord,
): string {
  const prev = ensureUserConfigFileSync(configPath);
  const draft = {
    ...prev,
    composio: {
      ...prev.composio,
      userId: record.userId,
      sessionId: record.sessionId,
      mcpUrl: record.mcpUrl,
      sessionPins: record.sessionPins ?? null,
    },
  };
  const validated = parseUserConfigFile(draft);
  writeUserConfigFileSync(configPath, validated);
  resetConfigCache();
  return configPath;
}

/**
 * Forget the cached session (but keep the user id, which is what
 * connected accounts hang off). Used when the operator clears or
 * replaces the key: the old session belonged to the old key.
 */
export function clearComposioSession(configPath: string): void {
  const prev = ensureUserConfigFileSync(configPath);
  const draft = {
    ...prev,
    composio: {
      ...prev.composio,
      sessionId: null,
      mcpUrl: null,
      sessionPins: null,
    },
  };
  writeUserConfigFileSync(configPath, parseUserConfigFile(draft));
  resetConfigCache();
}

/**
 * Replace `composio.accounts` (ATO-548). The list is validated by the
 * same parser the config loader uses, so a list with a duplicate alias
 * or two defaults for one toolkit is refused before anything is
 * written. The cached session is left alone: its pin stamp no longer
 * matches when a default changed, so the next mount creates a session
 * with the new pins and an unchanged default keeps the cache.
 */
export function persistComposioAccounts(
  configPath: string,
  accounts: readonly ComposioAccount[],
): string {
  const prev = ensureUserConfigFileSync(configPath);
  const draft = {
    ...prev,
    composio: { ...prev.composio, accounts: accounts.map((a) => ({ ...a })) },
  };
  writeUserConfigFileSync(configPath, parseUserConfigFile(draft));
  resetConfigCache();
  return configPath;
}
