import type { ReasoningExtractor } from "./reasoning-extractor.js";
import { extractPartialReplyTextFromToolArguments } from "./tool-arguments-stream-parser.js";

export interface OpenAiToolCallDelta {
  /** Provider-supplied call index. Some OpenAI-compatible APIs omit it. */
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
      emittedReplyLength: extractPartialReplyTextFromToolArguments(toolArgsBuffer).length,
      done: false,
      finishReason: null,
      modelId: null,
      usage: null,
      toolCallDeltas: [],
    };
  }
  const joined = dataLines.join("\n");
  if (joined === "[DONE]") {
    return {
      delta: "",
      reasoningDelta: "",
      toolArgsBuffer,
      emittedReplyLength: extractPartialReplyTextFromToolArguments(toolArgsBuffer).length,
      done: true,
      finishReason: null,
      modelId: null,
      usage: null,
      toolCallDeltas: [],
    };
  }
  try {
    const payload = JSON.parse(joined) as Record<string, unknown>;
    const choice = (payload.choices as Array<Record<string, unknown>> | undefined)?.[0];
    const delta = (choice?.delta as Record<string, unknown> | undefined) ?? {};
    const content = typeof delta.content === "string" ? delta.content : "";
    const reasoningDelta = reasoning.extractDelta({ delta });
    const finishReason =
      typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
    const modelId = typeof payload.model === "string" ? payload.model : null;
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
      return {
        delta: "",
        reasoningDelta,
        toolArgsBuffer: nextBuffer,
        toolArgsDelta: true,
        emittedReplyLength:
          extractPartialReplyTextFromToolArguments(toolArgsBuffer).length,
        done: false,
        finishReason,
        modelId,
        usage,
        toolCallDeltas: toolCalls.map((toolCall) => ({
          ...(typeof toolCall.index === "number" ? { index: toolCall.index } : {}),
          ...(typeof toolCall.id === "string" ? { id: toolCall.id } : {}),
          ...(toolCall.type === "function" ? { type: "function" as const } : {}),
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
      toolCallDeltas: [],
    };
  } catch {
    return {
      delta: "",
      reasoningDelta: "",
      toolArgsBuffer,
      emittedReplyLength: extractPartialReplyTextFromToolArguments(toolArgsBuffer).length,
      done: false,
      finishReason: null,
      modelId: null,
      usage: null,
      toolCallDeltas: [],
    };
  }
}
