import type { ReasoningExtractor } from "./reasoning-extractor.js";
import { extractPartialReplyTextFromToolArguments } from "./tool-arguments-stream-parser.js";

export interface OpenAiToolCallDelta {
  /**
   * The provider's own slot number, when it sends one. Omitted otherwise:
   * some OpenAI-compatible providers emit one whole call per event with no
   * `index` at all, and inventing a position here makes every one of them
   * look like slot 0. Resolving identity needs state across events, so the
   * stream consumer owns it.
   */
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export function parseOpenAiSseEvent(
  rawEvent: string,
  reasoning: ReasoningExtractor,
  toolArgsBuffer: string,
): {
  delta: string;
  reasoningDelta: string;
  toolArgsBuffer: string;
  toolArgsDelta?: boolean;
  emittedReplyLength: number;
  done: boolean;
  finishReason: string | null;
  modelId: string | null;
  usage: Record<string, unknown> | null;
  toolCallDeltas: OpenAiToolCallDelta[];
  /** The provider's generation id (`id` on the chunk), when it sends one. */
  id: string | null;
  /**
   * A mid-stream error event (`{"error": {"code": 504, "message": …}}`,
   * how OpenRouter reports an upstream that died after output started).
   * The consumer throws on it; a chunk carrying one has no delta.
   */
  error: { status: number | null; message: string } | null;
} {
  const dataLines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return {
      delta: "",
      reasoningDelta: "",
      toolArgsBuffer,
      emittedReplyLength:
        extractPartialReplyTextFromToolArguments(toolArgsBuffer).length,
      done: false,
      finishReason: null,
      modelId: null,
      usage: null,
      toolCallDeltas: [],
      id: null,
      error: null,
    };
  }
  const joined = dataLines.join("\n");
  if (joined === "[DONE]") {
    return {
      delta: "",
      reasoningDelta: "",
      toolArgsBuffer,
      emittedReplyLength:
        extractPartialReplyTextFromToolArguments(toolArgsBuffer).length,
      done: true,
      finishReason: null,
      modelId: null,
      usage: null,
      toolCallDeltas: [],
      id: null,
      error: null,
    };
  }
  try {
    const payload = JSON.parse(joined) as Record<string, unknown>;
    const choice = (
      payload.choices as Array<Record<string, unknown>> | undefined
    )?.[0];
    const delta = (choice?.delta as Record<string, unknown> | undefined) ?? {};
    const content = typeof delta.content === "string" ? delta.content : "";
    const reasoningDelta = reasoning.extractDelta({ delta });
    const finishReason =
      typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
    const modelId = typeof payload.model === "string" ? payload.model : null;
    const id = typeof payload.id === "string" && payload.id.length > 0 ? payload.id : null;
    const error = readStreamError(payload.error);
    const usage =
      payload.usage && typeof payload.usage === "object"
        ? (payload.usage as Record<string, unknown>)
        : null;
    const toolCalls = delta.tool_calls as
      | Array<{
          index?: number;
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>
      | undefined;
    if (toolCalls && toolCalls.length > 0) {
      const frag = toolCalls[0]?.function?.arguments ?? "";
      const nextBuffer = toolArgsBuffer + frag;
      // A chunk that carries both text and a tool-call delta keeps its
      // text: some services (Gemini's compatibility layer, Anthropic
      // shims) put the model's prose and its call in one event, and
      // dropping the prose here lost the reply that went with the call.
      return {
        delta: content,
        reasoningDelta,
        toolArgsBuffer: nextBuffer,
        toolArgsDelta: true,
        emittedReplyLength:
          extractPartialReplyTextFromToolArguments(toolArgsBuffer).length,
        done: false,
        finishReason,
        modelId,
        usage,
        id,
        error,
        toolCallDeltas: toolCalls.map((toolCall) => ({
          ...(typeof toolCall.index === "number"
            ? { index: toolCall.index }
            : {}),
          ...(typeof toolCall.id === "string" ? { id: toolCall.id } : {}),
          ...(toolCall.type === "function"
            ? { type: "function" as const }
            : {}),
          ...(toolCall.function
            ? {
                function: {
                  ...(typeof toolCall.function.name === "string"
                    ? { name: toolCall.function.name }
                    : {}),
                  ...(typeof toolCall.function.arguments === "string"
                    ? { arguments: toolCall.function.arguments }
                    : {}),
                },
              }
            : {}),
        })),
      };
    }
    return {
      delta: content,
      reasoningDelta,
      toolArgsBuffer,
      emittedReplyLength:
        extractPartialReplyTextFromToolArguments(toolArgsBuffer).length,
      done: false,
      finishReason,
      modelId,
      usage,
      id,
      error,
      toolCallDeltas: [],
    };
  } catch {
    return {
      delta: "",
      reasoningDelta: "",
      toolArgsBuffer,
      emittedReplyLength:
        extractPartialReplyTextFromToolArguments(toolArgsBuffer).length,
      done: false,
      finishReason: null,
      modelId: null,
      usage: null,
      toolCallDeltas: [],
      id: null,
      error: null,
    };
  }
}

function readStreamError(
  value: unknown,
): { status: number | null; message: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const error = value as { code?: unknown; message?: unknown };
  const code =
    typeof error.code === "number"
      ? error.code
      : typeof error.code === "string" && /^\d{3}$/.test(error.code)
        ? Number(error.code)
        : null;
  const message =
    typeof error.message === "string" && error.message.length > 0
      ? error.message
      : "stream error";
  return { status: code, message };
}
