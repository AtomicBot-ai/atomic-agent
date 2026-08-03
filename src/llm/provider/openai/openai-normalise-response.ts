import type { CompletionResult } from "../completion-types.js";

export function normaliseOpenAiChatResponse(
  json: Record<string, unknown>,
  defaultChatModel: string,
): CompletionResult {
  const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
  const message = (choice.message as Record<string, unknown> | undefined) ?? {};
  const usage = (json.usage as Record<string, unknown> | undefined) ?? {};
  const toolCalls = message.tool_calls as CompletionResult["toolCalls"];
  const content = normaliseMessageContent(message.content);
  // Reasoning models served over OpenAI-compatible APIs (Qwen3.8 with
  // preserve_thinking, DeepSeek-R1) return their CoT in a dedicated
  // `reasoning_content` field alongside `content`.
  const reasoningContent =
    typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  return {
    content,
    reasoningContent,
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

/**
 * `message.content` is a plain string on most servers, but multimodal
 * responses may carry an array of content parts. Join the text parts so
 * the runtime never mistakes a parts-array response for an empty one.
 */
export function normaliseMessageContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) =>
        part !== null &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}
