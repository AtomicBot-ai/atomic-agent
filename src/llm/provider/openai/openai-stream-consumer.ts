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
  /** Position in the final array. See `orderFor`. */
  order: number;
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
};

/**
 * Cross-event state for assembling streamed tool calls.
 *
 * A delta belongs to one call ("slot"), and the provider says which in one
 * of two ways — or in neither:
 *
 *   - `index` — OpenAI's own scheme. Authoritative whenever it is present.
 *   - `id` — one whole call per event and no index at all, as several
 *     OpenAI-compatible providers do. Keying those by array position folds
 *     every call onto slot 0, which merges distinct calls into one (#103).
 *   - neither — a continuation of a call already opened, matched by
 *     position against the slots that existed before this event.
 */
type ToolCallAccumulator = {
  /** Slots by resolved key: `#<index>`, `@<id>`, or `~<n>` for neither. */
  slots: Map<string, MutableToolCall>;
  /** Slot key per call id, so a later id-only delta finds its own slot. */
  keyById: Map<string, string>;
  /** Next `order` to hand out for a slot the provider did not index. */
  nextOrder: number;
};

function createToolCallAccumulator(): ToolCallAccumulator {
  return { slots: new Map(), keyById: new Map(), nextOrder: 0 };
}

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
      const toolCalls = createToolCallAccumulator();
      try {
        while (true) {
          if (signal?.aborted) break;
          const { done, value } = await reader.read();
          if (done) {
            // Flush TextDecoder state and treat a final non-empty SSE event
            // as an implicit last boundary. Some providers/proxies close the
            // response immediately after the terminal event instead of
            // writing the conventional trailing blank line.
            buffer += decoder.decode();
          } else {
            buffer += decoder.decode(value, { stream: true });
          }
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0 || (done && buffer.trim().length > 0)) {
            const rawEvent = boundary >= 0 ? buffer.slice(0, boundary) : buffer;
            buffer = boundary >= 0 ? buffer.slice(boundary + 2) : "";
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
          if (done) break;
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
  accumulator: ToolCallAccumulator,
  deltas: readonly OpenAiToolCallDelta[],
): void {
  // Snapshot before the loop: positional fallback matches against the slots
  // that were open when the event arrived, never against ones it creates.
  const openKeys = [...accumulator.slots.keys()];
  let position = 0;
  for (const delta of deltas) {
    const key = resolveSlotKey(accumulator, delta, position, openKeys);
    position += 1;
    let current = accumulator.slots.get(key);
    if (!current) {
      current = {
        order: orderFor(accumulator, delta),
        function: { name: "", arguments: "" },
      };
      accumulator.slots.set(key, current);
    }
    if (delta.id) {
      current.id = delta.id;
      accumulator.keyById.set(delta.id, key);
    }
    if (delta.type) current.type = delta.type;
    if (delta.function?.name) {
      current.function.name = mergeToolName(
        current.function.name,
        delta.function.name,
      );
    }
    if (delta.function?.arguments) {
      current.function.arguments += delta.function.arguments;
    }
  }
}

function resolveSlotKey(
  accumulator: ToolCallAccumulator,
  delta: OpenAiToolCallDelta,
  position: number,
  openKeys: readonly string[],
): string {
  if (typeof delta.index === "number") return `#${delta.index}`;
  if (delta.id !== undefined) {
    return accumulator.keyById.get(delta.id) ?? `@${delta.id}`;
  }
  return openKeys[position] ?? `~${accumulator.slots.size}`;
}

/**
 * Provider indexes double as the output position, so a stream that opens
 * slot 1 before slot 0 still ends up in the provider's order. Slots the
 * provider never indexed queue up behind the highest index seen so far, in
 * arrival order.
 */
function orderFor(
  accumulator: ToolCallAccumulator,
  delta: OpenAiToolCallDelta,
): number {
  if (typeof delta.index === "number") {
    accumulator.nextOrder = Math.max(accumulator.nextOrder, delta.index + 1);
    return delta.index;
  }
  return accumulator.nextOrder++;
}

/**
 * Fold a streamed `function.name` fragment into what we have so far.
 *
 * Arguments really are fragments and really do concatenate. A *name*
 * does not: the OpenAI streaming contract sends it once, whole, in the
 * first delta for its index — so the accumulator appended, and that was
 * right for every provider that follows the contract.
 *
 * Anthropic-compatible endpoints repeat the **full name in every delta**
 * for the call. Appending them produced tool names like
 * `replyreplyreplyreplyreply…`, which failed registry lookup and killed
 * the turn with `tool not registered in this agent` — the whole model
 * family was unusable, and the error named a tool nobody had written.
 *
 * So: a chunk identical to what is already accumulated is a repeat and
 * is dropped; anything else is appended, which keeps genuine
 * fragmentation (`re` + `ply`) working for any provider that does it.
 * The two cases are distinguishable and this is the only rule that
 * serves both.
 */
export function mergeToolName(current: string, incoming: string): string {
  if (current.length === 0) return incoming;
  if (current === incoming) return current;
  // A provider that repeats the whole name *and* has already been
  // appended to once — `replyreply` arriving alongside another `reply`.
  // Cheap to check, and it is the shape a partially-fixed stream takes.
  if (current.endsWith(incoming) && current.length % incoming.length === 0) {
    const repeats = current.length / incoming.length;
    if (incoming.repeat(repeats) === current) return current;
  }
  return current + incoming;
}

function buildFinalResult(args: {
  content: string;
  reasoningContent: string;
  finishReason: string | null;
  modelId: string | null;
  usage?: CompletionUsage;
  toolCalls: ToolCallAccumulator;
  terminalObserved: boolean;
}): StreamFinalResult {
  const sortedToolCalls = [...args.toolCalls.slots.values()]
    .sort((a, b) => a.order - b.order)
    .map((call) => toOpenAiToolCall(call))
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
