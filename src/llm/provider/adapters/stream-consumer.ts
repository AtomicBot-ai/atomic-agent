import type { StreamChunk, StreamFinalResult } from "../completion-types.js";

/**
 * Consumes a provider-specific SSE byte stream and yields normalized
 * `StreamChunk` values for `step-executor.consumeStream`.
 */
export interface StreamConsumer {
  consume(
    body: ReadableStream<Uint8Array> | null,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk, StreamFinalResult | void, void>;
}
