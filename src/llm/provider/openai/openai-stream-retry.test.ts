import { describe, expect, it, vi } from "vitest";

import type {
  CompletionResult,
  StreamChunk,
  StreamFinalResult,
} from "../completion-types.js";
import type { StreamConsumer } from "../adapters/stream-consumer.js";
import { classifyFailure } from "../../reliability/classify-failure.js";
import { shouldAdvance } from "../../fallback/should-advance.js";
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

function provider(
  fetchImpl: unknown,
  streamConsumer?: StreamConsumer,
): OpenAiProvider {
  return new OpenAiProvider({
    id: "test",
    baseUrl: "https://example.invalid",
    apiKey: "",
    defaultChatModel: "qwen-test",
    fetchImpl: fetchImpl as typeof fetch,
    ...(streamConsumer ? { streamConsumer } : {}),
  });
}

/** One SSE event carrying a streamed `function.arguments` fragment. */
function toolArgsFrame(
  fragment: string,
  extras: { name?: string; id?: string } = {},
): string {
  return frame({
    model: "qwen-test",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              ...(extras.id ? { id: extras.id } : {}),
              type: "function",
              function: {
                ...(extras.name ? { name: extras.name } : {}),
                arguments: fragment,
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
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

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // The shape matters as much as the absent retry: a turn the user
    // stopped has to classify as `cancelled`, or the fallback chain reads
    // it as a dead provider and restarts the completion on another link.
    expect(classifyFailure(error)).toBe("cancelled");
    expect(shouldAdvance(error).advance).toBe(false);
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
    // 500s are retried by `runOpenAiWithRetry` itself, and those retries
    // come out of the completion's budget — so by the time the error
    // reaches this layer there is nothing left to spend on a reopen.
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

    const startedAt = Date.now();
    const { error } = await drainToError(
      provider(fetchImpl).completeStream({ prompt: "hi" }),
    );

    expect((error as Error).message).toBe("terminated");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Two reopens means two `openAiRetryBackoff` waits (~150ms and
    // ~300ms before jitter). Asserted as a floor because a reopen loop
    // with no pacing is a provider-hammering loop, and nothing else here
    // would notice if the backoff were dropped.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
  });
});

/**
 * The budget is the whole reason this layer is safe to have: two bounded
 * retry loops that do not share a counter are one multiplying loop. Each
 * of these pins a scenario that cost 9 HTTP requests for a single turn
 * while the sharing was only asserted in a comment.
 */
describe("OpenAiProvider stream transport retry (shared attempt budget)", () => {
  it("spends one budget across opens and reopens, not one per layer", async () => {
    // The worst shape: every open pays two 500s before it succeeds, and
    // every body then dies before its first chunk. With a per-layer
    // budget that is 3 opens x 3 attempts = 9 requests for one turn —
    // nine billable prompt submissions.
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls % 3 === 0
        ? streamingResponse([new Error("terminated")])
        : new Response("upstream exploded", { status: 500 });
    });

    const { error } = await drainToError(
      provider(fetchImpl).completeStream({ prompt: "hi" }),
    );

    expect((error as Error).message).toBe("terminated");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("costs an unreachable provider three requests, not nine", async () => {
    // `ECONNREFUSED` is the one open failure that is BOTH typed as an
    // `OpenAiHttpError` and recognised by `isNetworkError`, so it is
    // where the two layers most want to retry each other's work.
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        code: "ECONNREFUSED",
      });
    });

    const { error } = await drainToError(
      provider(fetchImpl).completeStream({ prompt: "hi" }),
    );

    expect(error).toBeInstanceOf(OpenAiHttpError);
    expect((error as OpenAiHttpError).code).toBe("ECONNREFUSED");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not reopen a non-retryable open failure that merely looks like a socket death", async () => {
    // The case the `OpenAiHttpError` guard actually owns. A 400 is not
    // retryable, so the HTTP client throws it with budget to spare — and
    // its message carries the provider's body, which here mentions a
    // socket, so `isNetworkError` says yes. Without that guard this layer
    // would override the client's "deterministic, do not retry" verdict
    // and spend the rest of the completion's budget on it.
    const fetchImpl = vi.fn(
      async () => new Response("socket hang up upstream", { status: 400 }),
    );

    const { error } = await drainToError(
      provider(fetchImpl).completeStream({ prompt: "hi" }),
    );

    expect(error).toBeInstanceOf(OpenAiHttpError);
    expect((error as OpenAiHttpError).status).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAiProvider stream transport retry (cancellation and commit ordering)", () => {
  it("fails as cancelled when Esc lands during the inter-attempt backoff", async () => {
    // The window this layer added: the first body is already dead, the
    // reopen has not happened yet, and the user — who has been staring at
    // a frozen screen for a minute — presses Esc. `sleep()` resolves on
    // abort rather than throwing, so without an explicit re-check the
    // loop walks straight into another request, and the failure it ends
    // up producing classifies as `transport`, which makes the fallback
    // chain switch providers and restart the turn the user just stopped.
    const controller = new AbortController();
    let firstFetchSeen: () => void = () => {};
    const firstFetch = new Promise<void>((resolve) => {
      firstFetchSeen = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      firstFetchSeen();
      return streamingResponse([new Error("terminated")]);
    });

    const pending = drainToError(
      provider(fetchImpl).completeStream({
        prompt: "hi",
        signal: controller.signal,
      }),
    );
    await firstFetch;
    // Comfortably inside the ~150ms first backoff, and after the body has
    // errored (it errors on its very first `pull`).
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const { error } = await pending;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(classifyFailure(error)).toBe("cancelled");
    expect(shouldAdvance(error).advance).toBe(false);
  });

  it("treats output as delivered the moment it is yielded, not after", async () => {
    // `generator.throw()` is how a consumer reports its own failure into
    // a stream it is draining, and it resumes this generator *inside* the
    // catch, with the yield never having returned. If `committed` were
    // set after the yield instead of before, that error would find
    // `committed === false` and replay a completion the caller has
    // already shown part of.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        streamingResponse([contentFrame("part one"), STOP_FRAMES]),
      )
      .mockResolvedValueOnce(
        streamingResponse([contentFrame("part one again"), STOP_FRAMES]),
      );

    const stream = provider(fetchImpl).completeStream({ prompt: "hi" });
    const first = await stream.next();

    expect(first.done).toBe(false);
    await expect(stream.throw(new Error("terminated"))).rejects.toThrow(
      "terminated",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reopens a stream that only ever streamed tool-call arguments", async () => {
    // Not a hole in the committed rule but a documented edge of it: the
    // consumer yields on a `function.arguments` delta only once the
    // accumulated arguments contain reply text, so a tool call whose
    // arguments were still in flight commits nothing and is replayed.
    // Safe — nothing reached the user and tools are dispatched only after
    // the completion returns — but it is a wider window than "any byte
    // the provider sent", so it is pinned rather than left to be
    // rediscovered as a surprise.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        streamingResponse([
          toolArgsFrame("", { id: "c1", name: "read_file" }),
          toolArgsFrame('{"path":"a.txt"'),
          new Error("terminated"),
        ]),
      )
      .mockResolvedValueOnce(
        streamingResponse([
          toolArgsFrame('{"path":"b.txt"}', { id: "c2", name: "read_file" }),
          STOP_FRAMES,
        ]),
      );

    const { chunks, result } = await drain(
      provider(fetchImpl).completeStream({ prompt: "hi" }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(chunks.map((c) => c.delta).join("")).toBe("");
    // Only the second attempt's tool call survives — the half-streamed
    // arguments of the dead one must not stack onto it.
    expect(result.toolCalls).toEqual([
      {
        id: "c2",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"b.txt"}' },
      },
    ]);
  });

  it("starts a reopened stream from an empty transcript", async () => {
    // The built-in consumer cannot accumulate without also committing, so
    // the per-reopen reset only bites for an injected `streamConsumer` —
    // a public constructor option — that reports content on a chunk this
    // loop does not yield. Without the reset the replay stacks on top of
    // the dead attempt's text.
    let consumeCalls = 0;
    const consumer: StreamConsumer = {
      async *consume(): AsyncGenerator<StreamChunk, StreamFinalResult | void, void> {
        consumeCalls += 1;
        if (consumeCalls === 1) {
          yield { delta: "ghost", reasoningDelta: "", done: true };
          throw new Error("terminated");
        }
        yield { delta: "real", reasoningDelta: "", done: true };
        return {
          content: "",
          reasoningContent: "",
          finishReason: "stop",
          modelId: "qwen-test",
          terminalObserved: true,
        };
      },
    };
    const fetchImpl = vi.fn(async () => streamingResponse([STOP_FRAMES]));

    const { result } = await drain(
      provider(fetchImpl, consumer).completeStream({ prompt: "hi" }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.content).toBe("real");
  });
});
