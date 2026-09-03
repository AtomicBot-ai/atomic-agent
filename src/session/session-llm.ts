/**
 * Which provider/model a session runs on, remembered per session.
 *
 * The active text provider and its default chat model are one global
 * config setting, so historically every session silently followed
 * whatever the operator last picked — switch from an OpenRouter thread
 * into a local-llama thread and the OpenRouter model kept serving it.
 * The stamp records the session's own choice in `metadata` (under
 * {@link SESSION_LLM_METADATA_KEY}) so switching back into a thread can
 * re-apply the provider/model it actually ran on.
 *
 * Written by two hands: `executeTurn` stamps the configured active
 * provider/model at the start of every turn (all origins funnel through
 * it), and the TUI stamps immediately when the operator picks a model
 * while a session is open — so a choice made between turns is not lost
 * by switching away before the next message.
 */

/** Reserved `SessionState.metadata` key the stamp lives under. */
export const SESSION_LLM_METADATA_KEY = "llm";

export interface SessionLlmStamp {
  /** Config id of the text provider the session runs on. */
  providerId: string;
  /**
   * Chat model id on that provider, or `null` when the provider entry
   * names none (a bare llama-server serves whatever it loaded).
   */
  chatModel: string | null;
}

/**
 * Read the stamp back out of session metadata. Defensive on purpose:
 * metadata is a free-form JSON bag that old sessions, other writers and
 * hand-edited stores all feed into, so a malformed value degrades to
 * "no stamp" rather than a crash or a garbage provider switch.
 */
export function readSessionLlmStamp(
  metadata: Record<string, unknown> | undefined,
): SessionLlmStamp | null {
  const raw = metadata?.[SESSION_LLM_METADATA_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const providerId = (raw as { providerId?: unknown }).providerId;
  if (typeof providerId !== "string" || providerId.length === 0) return null;
  const chatModel = (raw as { chatModel?: unknown }).chatModel;
  return {
    providerId,
    chatModel:
      typeof chatModel === "string" && chatModel.length > 0 ? chatModel : null,
  };
}
