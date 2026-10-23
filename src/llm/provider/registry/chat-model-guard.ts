import type { LlmProviderConfigEntry } from "./provider-types.js";

/**
 * True for a config entry that is built and listed but can never serve
 * chat: an `openai-compatible` / `qwen-openai-compatible` entry with no
 * `defaultChatModel`. The factories only accept that shape for an
 * embedding-only provider (#410), and every chat call on it throws
 * "has no defaultChatModel configured", so it must not become the
 * active text provider (ATO-386).
 *
 * Keyed on the config entry, not on an empty chat model id: a
 * `llama-server` entry legitimately has none, because it serves
 * whatever model its daemon loaded.
 */
export function entryHasNoChatModel(entry: LlmProviderConfigEntry): boolean {
  return (
    (entry.kind === "openai-compatible" ||
      entry.kind === "qwen-openai-compatible") &&
    !entry.defaultChatModel
  );
}
