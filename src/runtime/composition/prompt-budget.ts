import type { LlmPromptBudget } from "../../error-reporting/index.js";
import type { BuiltPrompt } from "../../prompt/build-prompt-types.js";

/**
 * The budget parts of a built prompt (ATO-1678): the numbers that say
 * whether a full window was the history, the prefix, the native tool
 * schemas or the reply reserve. Counts only; no text is read.
 */
export function promptBudgetOf(prompt: BuiltPrompt): LlmPromptBudget {
  return {
    totalTokens: prompt.tokens.total,
    stablePrefixTokens: prompt.tokens.stablePrefix,
    toolSchemaTokens: prompt.tokens.toolSchema ?? 0,
    conversationTokens: prompt.tokens.conversation,
    contextWindow: prompt.contextWindow,
    replyReserve: prompt.contextBudget?.replyReserve ?? prompt.replyReserve ?? null,
  };
}
