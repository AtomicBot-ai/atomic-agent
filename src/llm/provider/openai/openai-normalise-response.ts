import type { CompletionResult } from "../completion-types.js";

export function normaliseOpenAiChatResponse(
  json: Record<string, unknown>,
  defaultChatModel: string,
): CompletionResult {
  const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
  const message = (choice.message as Record<string, unknown> | undefined) ?? {};
  const usage = (json.usage as Record<string, unknown> | undefined) ?? {};
  const toolCalls = message.tool_calls as CompletionResult["toolCalls"];
  const content = typeof message.content === "string" ? message.content : "";
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: choice.finish_reason === "length",
    timing: {
      promptMs: 0,
      predictedMs: 0,
      promptTokens: Number(usage.prompt_tokens ?? 0),
      predictedTokens: Number(usage.completion_tokens ?? 0),
    },
    cacheHitTokens: 0,
    slotId: -1,
    modelId: typeof json.model === "string" ? json.model : defaultChatModel,
    usage: {
      promptTokens: Number(usage.prompt_tokens ?? 0),
      completionTokens: Number(usage.completion_tokens ?? 0),
      totalTokens: Number(usage.total_tokens ?? 0),
    },
    toolCalls,
    finishReason:
      typeof choice.finish_reason === "string" ? choice.finish_reason : null,
  };
}
