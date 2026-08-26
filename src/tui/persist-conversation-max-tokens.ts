import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";

/**
 * Persist `agent.conversationMaxTokens` into the user config file, then
 * invalidate the global config cache so the next `getConfig()` sees it.
 * Mirrors the other `persist-*` helpers: read → merge → validate → write
 * → reset.
 *
 * **This one needs no hot-apply.** Unlike the approval ladder, which
 * lives on the running gate and has to be pushed at it, the transcript
 * cap is read out of `getConfig()` by `buildPrompt` on every single
 * build — so resetting the cache *is* the hot-apply, and the next turn
 * is packed against the new value.
 *
 * `0` is the auto sentinel (`CONVERSATION_CAP_AUTO`), which is why the
 * parameter is a plain number rather than a positive int: the whole
 * point of the button that calls this is to write a zero.
 */
export function persistConversationMaxTokens(tokens: number): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = {
    ...prev,
    agent: { ...prev.agent, conversationMaxTokens: tokens },
  };
  const validated = parseUserConfigFile(draft);
  writeUserConfigFileSync(path, validated);
  resetConfigCache();
}
