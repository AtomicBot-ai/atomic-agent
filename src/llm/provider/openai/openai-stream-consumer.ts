import type { StreamConsumer } from "../adapters/stream-consumer.js";
import type {
  CompletionUsage,
  OpenAiToolCall,
  StreamFinalResult,
} from "../completion-types.js";
import type { ReasoningFormat } from "../llm-provider.js";
import { createReasoningExtractor } from "./reasoning-extractor.js";
import {
  parseOpenAiSseEvent,
  type OpenAiToolCallDelta,
} from "./parse-sse-chunk.js";
import { extractPartialReplyTextFromToolArguments } from "./tool-arguments-stream-parser.js";

type MutableToolCall = {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export function createOpenAiStreamConsumer(
  reasoningFormat: ReasoningFormat,
): StreamConsumer {
  const reasoning = createReasoningExtractor(reasoningFormat);
  return {
    async *consume(body, signal) {
      if (!body) return;
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let toolArgsBuffer = "";
      let content = "";
      let reasoningContent = "";
      let finishReason: string | null = null;
      let modelId: string | null = null;
      let usage: CompletionUsage | undefined;
      // A trustworthy terminal signal: an explicit provider finish_reason
      // on any chunk, or a parser-recognized terminal event (`[DONE]`).
      // Some OpenAI-compatible providers send a final finish_reason and
      // then simply close the connection without ever emitting `[DONE]` —
      // that still counts. A bare `reader.read()` EOF with neither must
      // NOT be conflated with either, since a still-open tool call's
      // arguments may be mid-stream.
      let terminalObserved = false;
      const toolCalls = new Map<number, MutableToolCall>();
      try {
        while (true) {
          if (signal?.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const chunk = parseOpenAiSseEvent(rawEvent, reasoning, toolArgsBuffer);
            content += chunk.delta;
            reasoningContent += chunk.reasoningDelta;
            if (chunk.finishReason !== null) terminalObserved = true;
            finishReason = chunk.finishReason ?? finishReason;
            modelId = chunk.modelId ?? modelId;
            usage = normaliseUsage(chunk.usage) ?? usage;
            applyToolCallDeltas(toolCalls, chunk.toolCallDeltas);
            if (chunk.done) {
              yield { delta: "", reasoningDelta: "", done: true };
              return buildFinalResult({
                content,
                reasoningContent,
                finishReason,
                modelId,
                usage,
                toolCalls,
                terminalObserved: true,
              });
            }
            if (chunk.toolArgsDelta !== undefined) {
              toolArgsBuffer = chunk.toolArgsBuffer;
              const replyText = extractPartialReplyTextFromToolArguments(
                toolArgsBuffer,
              );
              if (replyText.length > 0) {
                yield {
                  delta: replyText.slice(chunk.emittedReplyLength),
                  reasoningDelta: chunk.reasoningDelta,
                  done: false,
                };
              } else if (chunk.reasoningDelta.length > 0) {
                yield {
                  delta: "",
                  reasoningDelta: chunk.reasoningDelta,
                  done: false,
                };
              }
            } else {
              yield {
                delta: chunk.delta,
                reasoningDelta: chunk.reasoningDelta,
                done: false,
              };
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
      } finally {
        reader.releaseLock();
      }
      yield { delta: "", reasoningDelta: "", done: true };
      return buildFinalResult({
        content,
        reasoningContent,
        finishReason,
        modelId,
        usage,
        toolCalls,
        terminalObserved,
      });
    },
  };
}

function applyToolCallDeltas(
  toolCalls: Map<number, MutableToolCall>,
  deltas: readonly OpenAiToolCallDelta[],
): void {
  for (const delta of deltas) {
    const current = toolCalls.get(delta.index) ?? {
      function: { name: "", arguments: "" },
    };
    if (delta.id) current.id = delta.id;
    if (delta.type) current.type = delta.type;
    if (delta.function?.name) current.function.name += delta.function.name;
    if (delta.function?.arguments) {
      current.function.arguments += delta.function.arguments;
    }
    toolCalls.set(delta.index, current);
  }
}

function buildFinalResult(args: {
  content: string;
  reasoningContent: string;
  finishReason: string | null;
  modelId: string | null;
  usage?: CompletionUsage;
  toolCalls: ReadonlyMap<number, MutableToolCall>;
  terminalObserved: boolean;
}): StreamFinalResult {
  const sortedToolCalls = [...args.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => toOpenAiToolCall(call))
    .filter((call): call is OpenAiToolCall => call !== null);
  return {
    content: args.content,
    reasoningContent: args.reasoningContent,
    finishReason: args.finishReason,
    modelId: args.modelId,
    terminalObserved: args.terminalObserved,
    ...(args.usage ? { usage: args.usage } : {}),
    ...(sortedToolCalls.length > 0 ? { toolCalls: sortedToolCalls } : {}),
  };
}

function toOpenAiToolCall(call: MutableToolCall): OpenAiToolCall | null {
  if (call.function.name.length === 0) return null;
  return {
    ...(call.id ? { id: call.id } : {}),
    type: call.type ?? "function",
    function: {
      name: call.function.name,
      arguments: call.function.arguments,
    },
  };
}

function normaliseUsage(raw: Record<string, unknown> | null): CompletionUsage | undefined {
  if (!raw) return undefined;
  return {
    promptTokens: Number(raw.prompt_tokens ?? 0),
    completionTokens: Number(raw.completion_tokens ?? 0),
    totalTokens: Number(raw.total_tokens ?? 0),
  };
}
