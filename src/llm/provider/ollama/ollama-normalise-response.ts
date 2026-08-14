import type {
  CompletionResult,
  OpenAiToolCall,
} from "../completion-types.js";

/**
 * One parsed line of Ollama's native chat wire format — either a
 * streamed NDJSON chunk or the single body of a non-streaming call.
 * Field names follow api/types.go in the Ollama repo. Durations are
 * nanosecond integers; `thinking` is a separate channel from `content`;
 * tool call `arguments` arrive as a JSON object, never a string.
 */
export interface OllamaChatChunk {
  model?: string;
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: ReadonlyArray<{
      id?: string;
      function?: {
        index?: number;
        name?: string;
        arguments?: Record<string, unknown>;
      };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  error?: string;
}

const NS_PER_MS = 1_000_000;

/**
 * Map a final Ollama chat payload onto the provider-agnostic
 * `CompletionResult`. Tool call arguments are re-serialized to a JSON
 * string because the shared `OpenAiToolCall` contract (and the tool
 * call adapter behind it) expects the OpenAI wire shape.
 */
export function completionFromOllamaChat(
  chunk: OllamaChatChunk,
  defaultChatModel: string,
  accumulated?: { content: string; thinking: string },
): CompletionResult {
  const content = accumulated?.content
    ? accumulated.content
    : (chunk.message?.content ?? "");
  const reasoningContent = accumulated?.thinking
    ? accumulated.thinking
    : (chunk.message?.thinking ?? "");
  const toolCalls = toolCallsFromOllama(chunk.message?.tool_calls);
  const promptTokens = chunk.prompt_eval_count ?? 0;
  const completionTokens = chunk.eval_count ?? 0;
  const truncated = chunk.done_reason === "length";
  return {
    content,
    reasoningContent,
    stop: !truncated,
    truncated,
    timing: {
      promptMs: (chunk.prompt_eval_duration ?? 0) / NS_PER_MS,
      predictedMs: (chunk.eval_duration ?? 0) / NS_PER_MS,
      promptTokens,
      predictedTokens: completionTokens,
    },
    cacheHitTokens: 0,
    slotId: -1,
    modelId: chunk.model ?? defaultChatModel,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    finishReason: finishReasonFromOllama(chunk, toolCalls.length > 0),
  };
}

export function toolCallsFromOllama(
  raw: NonNullable<OllamaChatChunk["message"]>["tool_calls"] | undefined,
): OpenAiToolCall[] {
  if (!raw) return [];
  const calls: OpenAiToolCall[] = [];
  for (const entry of raw) {
    const name = entry.function?.name;
    if (!name) continue;
    calls.push({
      ...(entry.id ? { id: entry.id } : {}),
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(entry.function?.arguments ?? {}),
      },
    });
  }
  return calls;
}

function finishReasonFromOllama(
  chunk: OllamaChatChunk,
  hasToolCalls: boolean,
): string {
  if (chunk.done_reason === "length") return "length";
  if (hasToolCalls) return "tool_calls";
  return chunk.done_reason ?? "stop";
}
