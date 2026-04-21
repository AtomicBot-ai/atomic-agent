import type { RunTurnResult } from "../agent/agent-loop.js";

/**
 * Builders for OpenAI-compatible `chat.completion` / `chat.completion.chunk`
 * payloads. Shapes mirror hermes-agent `_ConfigRoutes._build_stream_chunk`
 * and `_build_usage_payload` so any client library that already groks the
 * hermes gateway will work unchanged against atomic-agent.
 */

export interface ChatChoiceDelta {
  role?: "assistant";
  content?: string;
  [key: string]: unknown;
}

export interface UsagePayload {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface StreamChunkInput {
  completionId: string;
  created: number;
  model: string;
  delta?: ChatChoiceDelta;
  finishReason?: "stop" | "length" | "cancelled" | null;
  usage?: UsagePayload;
  extra?: Record<string, unknown>;
}

export interface StreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: ChatChoiceDelta;
    finish_reason: "stop" | "length" | "cancelled" | null;
  }>;
  usage?: UsagePayload;
  [key: string]: unknown;
}

/**
 * Build a single OpenAI `chat.completion.chunk` envelope. A non-null
 * `finishReason` signals the last non-[DONE] chunk; callers are expected
 * to write `data: [DONE]\n\n` themselves after the final usage/stop
 * chunk, matching OpenAI's own SSE protocol.
 */
export function buildStreamChunk(input: StreamChunkInput): StreamChunk {
  const chunk: StreamChunk = {
    id: input.completionId,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        delta: input.delta ?? {},
        finish_reason: input.finishReason ?? null,
      },
    ],
  };
  if (input.usage) chunk.usage = input.usage;
  if (input.extra) Object.assign(chunk, input.extra);
  return chunk;
}

/**
 * Derive a usage payload from the final turn outcome. Atomic-agent does
 * not track per-turn aggregated token counts yet — telemetry emits the
 * figures per-step via metrics, but does not fold them into
 * `RunTurnResult`. Until that plumbing lands we surface zeros so the
 * response is still schema-valid.
 */
export function buildUsagePayload(_result: RunTurnResult): UsagePayload {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
}

export interface FinalMessagePayload {
  message: { role: "assistant"; content: string };
  finish_reason: "stop" | "length" | "cancelled";
}

/**
 * Pull the final assistant turn out of a `RunTurnResult` so the
 * non-streaming handler can return a standard `chat.completion`
 * response. If the loop ended via `cancelled` / `max_steps` we still
 * return whatever text the model (or fallback) produced, labelled with
 * the matching finish_reason.
 */
export function buildFinalAssistantPayload(
  result: RunTurnResult,
): FinalMessagePayload {
  const lastReply = [...result.session.turns]
    .reverse()
    .find((t) => t.kind === "assistant_reply");
  const content = lastReply?.text ?? "";
  let finishReason: FinalMessagePayload["finish_reason"] = "stop";
  if (result.reason === "cancelled") finishReason = "cancelled";
  else if (result.reason === "max_steps") finishReason = "length";
  return {
    message: { role: "assistant", content },
    finish_reason: finishReason,
  };
}
