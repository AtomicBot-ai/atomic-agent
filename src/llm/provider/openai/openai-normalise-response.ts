import type { CompletionResult, CompletionUsage } from "../completion-types.js";
import type { ReasoningFormat } from "../llm-provider.js";
import { createReasoningExtractor } from "./reasoning-extractor.js";

export function normaliseOpenAiChatResponse(
  json: Record<string, unknown>,
  defaultChatModel: string,
  reasoningFormat: ReasoningFormat = "auto",
): CompletionResult {
  const choice =
    (json.choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
  const message = (choice.message as Record<string, unknown> | undefined) ?? {};
  const toolCalls = message.tool_calls as CompletionResult["toolCalls"];
  const content = normaliseMessageContent(message.content);
  // Reasoning models served over OpenAI-compatible APIs return their CoT
  // in a dedicated field alongside `content` — `reasoning_content`
  // (Qwen with preserve_thinking, DeepSeek-R1), `reasoning` (OpenRouter)
  // or `thinking`. Same extractor as the stream consumer, so the unary
  // and streamed paths cannot disagree about where reasoning lives.
  const reasoningContent = createReasoningExtractor(
    reasoningFormat,
  ).extractFromMessage(message);
  const usage = normaliseOpenAiUsage(
    json.usage as Record<string, unknown> | undefined,
  );
  return {
    content,
    reasoningContent,
    stop: true,
    truncated: choice.finish_reason === "length",
    timing: {
      promptMs: 0,
      predictedMs: 0,
      promptTokens: usage.promptTokens,
      predictedTokens: usage.completionTokens,
    },
    cacheHitTokens: 0,
    slotId: -1,
    modelId: typeof json.model === "string" ? json.model : defaultChatModel,
    usage,
    toolCalls,
    finishReason:
      typeof choice.finish_reason === "string" ? choice.finish_reason : null,
  };
}

/** One reading of an OpenAI-shaped `usage` block for both paths. */
export function normaliseOpenAiUsage(
  raw: Record<string, unknown> | undefined,
): CompletionUsage {
  const usage = raw ?? {};
  return {
    promptTokens: Number(usage.prompt_tokens ?? 0),
    completionTokens: Number(usage.completion_tokens ?? 0),
    totalTokens: Number(usage.total_tokens ?? 0),
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
