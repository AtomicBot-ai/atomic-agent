import { describe, expect, it, vi } from "vitest";

import type { CompletionResult, StreamChunk } from "../completion-types.js";
import { OpenAiHttpError } from "./openai-http.js";
import { OpenAiProvider } from "./openai-provider.js";

/** One SSE event, framed the way an OpenAI-compatible provider sends it. */
function frame(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function contentFrame(content: string): string {
  return frame({
    model: "qwen-test",
    choices: [
      { index: 0, delta: { role: "assistant", content }, finish_reason: null },
    ],
  });
}

/** The clean tail of a completion: finish_reason, usage, `[DONE]`. */
const STOP_FRAMES =
  frame({
    model: "qwen-test",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  }) + "data: [DONE]\n\n";

/**
 * A part of a fake response body: bytes to write, an `Error` that kills
 * the stream at that point, or a side effect to run first (used to abort
 * the caller's signal at a precise moment).
 */
type BodyPart = string | Error | (() => void);

/**
 * A streaming `Response` that plays `parts` one `pull()` at a time.
 *
 * Pull-driven on purpose: `ReadableStreamDefaultController.error()`
 * resets the queue, so a stream built by enqueueing everything up front
 * and then erroring would drop the deltas it had already queued — which
 * makes "the socket dies *after* a delta was delivered" untestable, and
 * that is the case that must NOT be retried.
 */
function streamingResponse(parts: readonly BodyPart[]): Response {
  const encoder = new TextEncoder();
  const queue = [...parts];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      while (queue.length > 0) {
        const part = queue.shift();
        if (typeof part === "function") {
          part();
          continue;
        }
        if (part instanceof Error) {
          controller.error(part);
          return;
        }
        if (typeof part === "string") {
          controller.enqueue(encoder.encode(part));
          return;
        }
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function provider(fetchImpl: unknown): OpenAiProvider {
  return new OpenAiProvider({
    id: "test",
    baseUrl: "https://example.invalid",
    apiKey: "",
    defaultChatModel: "qwen-test",
    fetchImpl: fetchImpl as typeof fetch,
  });
}

/** Drain a completion stream, keeping every chunk the caller was handed. */
async function drain(
  stream: AsyncGenerator<StreamChunk, CompletionResult, void>,
): Promise<{ chunks: StreamChunk[]; result: CompletionResult }> {
  const chunks: StreamChunk[] = [];
  for (;;) {
    const next = await stream.next();
    if (next.done) return { chunks, result: next.value };
    chunks.push(next.value);
  }
}

/** Drain until the stream throws; returns what was yielded before it did. */
async function drainToError(
  stream: AsyncGenerator<StreamChunk, CompletionResult, void>,
): Promise<{ chunks: StreamChunk[]; error: unknown }> {
  const chunks: StreamChunk[] = [];
  try {
    for (;;) {
      const next = await stream.next();
      if (next.done) return { chunks, error: null };
      chunks.push(next.value);
    }
  } catch (err) {
    return { chunks, error: err };
  }
}

/**
 * The window these tests pin: the provider answered 2xx, so
 * `openAiStartStream`'s retry is spent, but the socket died before a
 * single chunk reached the caller. Nothing was emitted downstream, so
 * reopening is invisible — and once anything HAS been emitted, it is not.
 */
describe("OpenAiProvider stream transport retry (pre-first-chunk)", () => {
  it("reopens when the body dies before the first delta, without duplicating output", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(streamingResponse([new Error("terminated")]))
      .mockResolvedValueOnce(
        streamingResponse([contentFrame("hello world"), STOP_FRAMES]),
      );

    const { chunks, result } = await drain(
      provider(fetchImpl).completeStream({ prompt: "hi" }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.content).toBe("hello world");
    // Exactly one delivery of the text — a replayed stream must not stack.
    expect(chunks.map((c) => c.delta).join("")).toBe("hello world");
  });

  it("does not retry once a delta has been yielded to the caller", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        streamingResponse([contentFrame("part one"), new Error("terminated")]),
      )
      .mockResolvedValueOnce(
        streamingResponse([contentFrame("part one"), STOP_FRAMES]),
      );

    const { chunks, error } = await drainToError(
      provider(fetchImpl).completeStream({ prompt: "hi" }),
    );

    expect((error as Error).message).toBe("terminated");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(chunks.map((c) => c.delta).join("")).toBe("part one");
  });

  it("treats a reasoning delta as output and refuses to retry after it", async () => {
    const reasoningFrame = frame({
      model: "qwen-test",
      choices: [
        {
          index: 0,
          // `reasoning` is the field the default `delta_reasoning` format reads.
          delta: { role: "assistant", reasoning: "thinking…" },
          finish_reason: null,
        },
      ],
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        streamingResponse([reasoningFrame, new Error("terminated")]),
      )
      .mockResolvedValueOnce(
        streamingResponse([contentFrame("hello"), STOP_FRAMES]),
      );

    const { chunks, error } = await drainToError(
      provider(fetchImpl).completeStream({ prompt: "hi" }),
    );

    expect((error as Error).message).toBe("terminated");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(chunks.map((c) => c.reasoningDelta).join("")).toBe("thinking…");
  });

  it("does not retry when the caller cancelled, even though the error looks like a drop", async () => {
    // The consumer is parked inside `reader.read()` while the gate is
    // closed, which is what makes the ordering deterministic: the abort
    // lands while a read is in flight, so the failure genuinely reaches
    // the retry decision as `Error: terminated` with an aborted signal —
    // the exact collision the cancellation guard exists for.
    const controller = new AbortController();
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(streamController) {
              await gate;
              streamController.error(new Error("terminated"));
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      )
      .mockResolvedValueOnce(
        streamingResponse([contentFrame("hello"), STOP_FRAMES]),
      );

    const pending = drainToError(
      provider(fetchImpl).completeStream({
        prompt: "hi",
        signal: controller.signal,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    openGate();
    const { error } = await pending;

    expect((error as Error).message).toBe("terminated");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failure that is not a transport death", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(streamingResponse([new Error("consumer bug")]))
      .mockResolvedValueOnce(
        streamingResponse([contentFrame("hello"), STOP_FRAMES]),
      );

    const { error } = await drainToError(
      provider(fetchImpl).completeStream({ prompt: "hi" }),
    );

    expect((error as Error).message).toBe("consumer bug");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not re-retry an open failure that already spent the HTTP budget", async () => {
    // 500s are retried by `runOpenAiWithRetry` itself. If this layer
    // retried the resulting `OpenAiHttpError` too, the budget would be
    // squared (3 × 3 = 9 requests) instead of shared.
    const fetchImpl = vi.fn(
      async () => new Response("upstream exploded", { status: 500 }),
    );

    const { error } = await drainToError(
      provider(fetchImpl).completeStream({ prompt: "hi" }),
    );

    expect(error).toBeInstanceOf(OpenAiHttpError);
    expect((error as OpenAiHttpError).status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("gives one streaming completion the shared attempt budget, then gives up", async () => {
    const fetchImpl = vi.fn(async () =>
      streamingResponse([new Error("terminated")]),
    );

    const { error } = await drainToError(
      provider(fetchImpl).completeStream({ prompt: "hi" }),
    );

    expect((error as Error).message).toBe("terminated");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
