/**
 * What actually came back over a probe's SSE stream.
 *
 * The probe reads the whole (small, bounded) body and then replays it
 * through `parseOpenAiSseEvent` and `mergeToolName` — the very parser
 * and name-merge rule a real turn uses. Reimplementing either here
 * would let the probe and the turn disagree about what a provider sent,
 * which is the one thing a conformance check must never do.
 *
 * It stops short of `createOpenAiStreamConsumer` on purpose. That
 * consumer answers "what should the agent act on", and to do it it
 * *drops* a tool call whose function name never arrived. A probe needs
 * the opposite: knowing that tool-call deltas were streamed but never
 * assembled into a callable tool is the whole diagnosis of a route with
 * malformed deltas.
 */

import { mergeToolName } from "../openai/openai-stream-consumer.js";
import { parseOpenAiSseEvent } from "../openai/parse-sse-chunk.js";
import { createReasoningExtractor } from "../openai/reasoning-extractor.js";

export interface ProbeToolCallObservation {
  readonly index: number;
  /** Empty when deltas for this index never carried a function name. */
  readonly name: string;
  /** Concatenated argument fragments, exactly as they arrived. */
  readonly arguments: string;
}

export interface ProbeStreamObservation {
  /** Assistant text, for the auto-mode "answered in prose" case. */
  readonly text: string;
  readonly toolCalls: readonly ProbeToolCallObservation[];
  /** A `tool_calls` delta was seen at all — even one naming nothing. */
  readonly sawToolCallDelta: boolean;
  readonly finishReason: string | null;
  /**
   * The provider said it was finished: an explicit `finish_reason` on
   * some chunk, or a `[DONE]` event. A body that simply stops carries
   * neither, and that is precisely `STREAM_EARLY_EOF`. Same rule the
   * stream consumer applies before it trusts a tool call.
   */
  readonly terminalObserved: boolean;
}

export function accumulateProbeStream(sse: string): ProbeStreamObservation {
  // The probe never asks for reasoning, and no probe verdict depends on
  // it, so the no-op extractor keeps the parser call honest without
  // pulling provider reasoning formats into the check.
  const reasoning = createReasoningExtractor("none");
  const calls = new Map<number, { name: string; arguments: string }>();
  let text = "";
  let sawToolCallDelta = false;
  let finishReason: string | null = null;
  let terminalObserved = false;

  for (const rawEvent of splitSseEvents(sse)) {
    const chunk = parseOpenAiSseEvent(rawEvent, reasoning, "");
    text += chunk.delta;
    if (chunk.finishReason !== null) {
      finishReason = chunk.finishReason;
      terminalObserved = true;
    }
    if (chunk.done) terminalObserved = true;
    if (chunk.toolArgsDelta === true) sawToolCallDelta = true;
    for (const delta of chunk.toolCallDeltas) {
      const current = calls.get(delta.index) ?? { name: "", arguments: "" };
      if (delta.function?.name) {
        current.name = mergeToolName(current.name, delta.function.name);
      }
      if (delta.function?.arguments) {
        current.arguments += delta.function.arguments;
      }
      calls.set(delta.index, current);
    }
  }

  return {
    text,
    toolCalls: [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({
        index,
        name: call.name,
        arguments: call.arguments,
      })),
    sawToolCallDelta,
    finishReason,
    terminalObserved,
  };
}

/**
 * SSE events are blank-line separated. A trailing chunk with no closing
 * blank line still counts: providers and proxies routinely close the
 * response straight after the terminal event, and treating that last
 * event as noise would turn a clean finish into a false early EOF.
 */
function splitSseEvents(sse: string): string[] {
  return sse
    .split("\n\n")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
