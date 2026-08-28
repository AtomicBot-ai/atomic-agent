import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";

/**
 * Persist `agent.conversationMaxPairs`, then invalidate the config cache
 * so the next `getConfig()` sees it.
 *
 * No hot-apply, for the same reason the transcript cap needs none:
 * `buildPrompt` reads `getConfig()` on every single build, so resetting
 * the cache *is* the hot-apply and the next turn is packed against the
 * new value.
 *
 * The caller is expected to have clamped to 1..100 already — the panel
 * does, so the number on screen and the number written are the same.
 * `parseUserConfigFile` re-checks regardless and throws rather than
 * writing something the next boot would reject.
 */
export function persistConversationMaxPairs(pairs: number): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = {
    ...prev,
    agent: { ...prev.agent, conversationMaxPairs: pairs },
  };
  const validated = parseUserConfigFile(draft);
  writeUserConfigFileSync(path, validated);
  resetConfigCache();
}
