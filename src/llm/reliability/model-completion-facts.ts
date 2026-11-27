import type { CompletionResult } from "../provider/completion-types.js";

/**
 * What a defective completion looked like, kept on `ModelError` for the
 * error report (ATO-2421). Shape only: no text of the reply or the
 * reasoning is kept, just whether each channel had any and the server's
 * own counts.
 *
 * `reason` says the reply was `empty`; these say which empty: a model
 * that thought and never answered (`reasoningPresent`), a server that
 * closed the turn at once (`finishReason`), or a prompt the server cut
 * before the model saw it (`promptTokens` far below the prompt the agent
 * built, as a local server with a small context does).
 */
export interface ModelCompletionFacts {
  /** The provider's `finish_reason` as sent; `null` when it sent none. */
  finishReason: string | null;
  /** llama-server's `stop_type`, when it reported one. */
  stopType?: string;
  /** The reasoning channel carried non-blank text. */
  reasoningPresent: boolean;
  /** Prompt tokens as the server counted them; `0` when unreported. */
  promptTokens: number;
  /** Reply tokens as the server counted them; `0` when unreported. */
  completionTokens: number;
}

/** {@link ModelCompletionFacts} of a completion. */
export function completionFactsOf(completion: CompletionResult): ModelCompletionFacts {
  const reasoning =
    typeof completion.reasoningContent === "string" ? completion.reasoningContent.trim() : "";
  return {
    finishReason: typeof completion.finishReason === "string" ? completion.finishReason : null,
    ...(typeof completion.stopType === "string" ? { stopType: completion.stopType } : {}),
    reasoningPresent: reasoning.length > 0,
    promptTokens: completion.usage?.promptTokens || completion.timing?.promptTokens || 0,
    completionTokens:
      completion.usage?.completionTokens || completion.timing?.predictedTokens || 0,
  };
}
