import type { CompletionResult } from "../../llm/provider/completion-types.js";
import type { BuiltPrompt } from "../../prompt/build-prompt-types.js";

/**
 * What the debug log says about a completion that came back defective
 * (empty, truncated, no stop), next to `reason` (ATO-1572, part of
 * ATO-352). A bare `reason: empty` could not tell a provider that
 * answered `finish_reason: "stop"` with nothing from one that hit its
 * length limit, nor which provider and model answered, nor how big the
 * request was.
 *
 * Numbers and short identifiers only: never message text, reasoning,
 * tool arguments or keys. `requestMessages` and `requestTokens` describe
 * the step's built prompt (system + packed turns + tail), the same for
 * the first call and its one-shot repair.
 */
export function completionDefectLogFields(
  completion: CompletionResult,
  prompt: Pick<BuiltPrompt, "messages" | "tokens">,
): Record<string, string | number | null> {
  const served = completion.servedModelMode;
  const usage = completion.usage;
  const timing = completion.timing;
  const fields: Record<string, string | number | null> = {
    finishReason: completion.finishReason ?? null,
    providerId: served?.providerId ?? null,
    model: completion.modelId ?? served?.modelId ?? null,
    promptTokens: usage?.promptTokens ?? positiveOrNull(timing?.promptTokens),
    completionTokens: usage?.completionTokens ?? (timing ? timing.predictedTokens : null),
    requestMessages: promptMessageCount(prompt.messages),
    requestTokens: prompt.tokens.total,
  };
  if (completion.stopType) fields["stopType"] = completion.stopType;
  if (completion.servedTransport) fields["transport"] = completion.servedTransport;
  if (completion.toolCalls !== undefined) fields["toolCalls"] = completion.toolCalls.length;
  if (completion.sentMaxTokens !== undefined) fields["sentMaxTokens"] = completion.sentMaxTokens;
  if (completion.generationId) fields["generationId"] = completion.generationId;
  return fields;
}

/** System, the optional summaries, every packed turn, and the final user message. */
function promptMessageCount(messages: BuiltPrompt["messages"]): number {
  return 1
    + (messages.contextSummary ? 1 : 0)
    + (messages.droppedSummary ? 1 : 0)
    + messages.turns.length
    + 1;
}

function positiveOrNull(n: number | undefined): number | null {
  return typeof n === "number" && n > 0 ? n : null;
}
