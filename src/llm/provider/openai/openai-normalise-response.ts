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
    cacheHitTokens: usage.cachedTokens ?? 0,
    slotId: -1,
    modelId: typeof json.model === "string" ? json.model : defaultChatModel,
    ...(typeof json.id === "string" && json.id.length > 0
      ? { generationId: json.id }
      : {}),
    usage,
    toolCalls,
    finishReason:
      typeof choice.finish_reason === "string" ? choice.finish_reason : null,
  };
}

/**
 * One reading of an OpenAI-shaped `usage` block for both paths.
 *
 * `prompt_tokens_details.cached_tokens` is where OpenAI, OpenRouter and
 * Gemini's compatibility layer report the prompt tokens served from a
 * prompt cache (Anthropic through OpenRouter lands there too; a shim
 * that speaks Anthropic's own `cache_read_input_tokens` is read as a
 * fallback). It is the only evidence a turn has that its caching
 * arrangement is working, so it rides on `usage` as `cachedTokens` —
 * absent, not zero, when the service did not say — and on
 * `cacheHitTokens`, which the trace already records per completion.
 */
export function normaliseOpenAiUsage(
  raw: Record<string, unknown> | undefined,
): CompletionUsage {
  const usage = raw ?? {};
  const details = usage.prompt_tokens_details;
  const cached =
    details !== null && typeof details === "object"
      ? (details as Record<string, unknown>).cached_tokens
      : usage.cache_read_input_tokens;
  return {
    promptTokens: Number(usage.prompt_tokens ?? 0),
    completionTokens: Number(usage.completion_tokens ?? 0),
    totalTokens: Number(usage.total_tokens ?? 0),
    ...(typeof cached === "number" && Number.isFinite(cached) && cached >= 0
      ? { cachedTokens: cached }
      : {}),
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
