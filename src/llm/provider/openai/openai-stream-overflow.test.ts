import { describe, expect, it } from "vitest";

import { createOpenAiStreamConsumer, OpenAiSseError } from "./openai-stream-consumer.js";
import { OpenAiHttpError } from "./openai-http.js";
import {
  isRequestSizeRejection,
  readContextLengthFromRejection,
  readServerContextCounts,
} from "../../reliability/request-size-rejection.js";

/**
 * ATO-2420: llama.cpp (Atomic Chat on 1337, an external llama-server on
 * its OpenAI route) reports an overflow after the stream opened as an
 * `error:` event line, not a `data:` one. Read only for `data:` lines,
 * the stream ended as an empty reply and the overflow compaction never
 * ran; and the server's `n_ctx` / `n_prompt_tokens` were lost.
 */
const OVERFLOW_LINE =
  'error: {"code":400,"message":"the request exceeds the available context size, try increasing it",' +
  '"type":"exceed_context_size_error","n_prompt_tokens":40123,"n_ctx":32768}\n\n';

function bodyOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function drainError(body: string): Promise<unknown> {
  const consumer = createOpenAiStreamConsumer("delta_reasoning");
  const iterator = consumer.consume(bodyOf(body), undefined);
  try {
    for (;;) {
      const step = await iterator.next();
      if (step.done) return null;
    }
  } catch (err) {
    return err;
  }
}

/** The typed error the provider builds over it (`httpErrorFromSse`). */
function asHttpError(err: OpenAiSseError): OpenAiHttpError {
  return new OpenAiHttpError(
    `openai provider ${err.status ?? "stream"}: ${err.message}`,
    err.status,
    "http://127.0.0.1:1337/v1/chat/completions",
    false,
    null,
    "atomic-chat",
    undefined,
    { cause: err, streamError: err.message },
  );
}

describe("a llama.cpp overflow inside an OpenAI-compatible stream (ATO-2420)", () => {
  it("throws on the `error:` line, with the status and the server's counts", async () => {
    const err = await drainError(OVERFLOW_LINE);
    expect(err).toBeInstanceOf(OpenAiSseError);
    const sse = err as OpenAiSseError;
    expect(sse.status).toBe(400);
    expect(sse.message).toBe("the request exceeds the available context size, try increasing it");
    expect(sse.counts).toEqual({ contextWindow: 32_768, promptTokens: 40_123 });
  });

  it("reads the error wrapped in `error` the same way", async () => {
    const err = await drainError(
      'error: {"error":{"code":400,"message":"context size exceeded","n_ctx":8192}}\n\n',
    );
    expect(err).toBeInstanceOf(OpenAiSseError);
    expect((err as OpenAiSseError).status).toBe(400);
    expect((err as OpenAiSseError).counts).toEqual({ contextWindow: 8192 });
  });

  it("is a context-size refusal whose counts the overflow compaction can read", async () => {
    const http = asHttpError((await drainError(OVERFLOW_LINE)) as OpenAiSseError);
    expect(isRequestSizeRejection(http)).toBe(true);
    expect(readServerContextCounts(http)).toEqual({ contextWindow: 32_768, promptTokens: 40_123 });
    expect(readContextLengthFromRejection(http)).toBe(32_768);
  });

  it("still ignores an event with neither line", async () => {
    expect(await drainError(": keep-alive\n\n")).toBeNull();
  });
});
