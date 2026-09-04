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

export interface ComposioSessionRecord {
  userId: string;
  sessionId: string;
  mcpUrl: string;
}

/** Persist the session triple. Returns the path written. */
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
    composio: { ...prev.composio, sessionId: null, mcpUrl: null },
  };
  writeUserConfigFileSync(configPath, parseUserConfigFile(draft));
  resetConfigCache();
}
