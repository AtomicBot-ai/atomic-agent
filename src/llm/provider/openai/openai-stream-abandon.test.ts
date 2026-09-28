import { describe, expect, it } from "vitest";

import type { StreamConsumer } from "../adapters/stream-consumer.js";
import { OpenAiProvider } from "./openai-provider.js";

/**
 * `completeStream` pumps its stream consumer by hand, so nothing closes
 * that consumer for it: a caller that abandons the outer generator
 * instead of driving it to `done` used to leave the consumer suspended at
 * its own `yield`, its reader lock held, and the fetch body unread.
 *
 * These tests watch the consumer's `finally` and the body's `cancel()`,
 * which are the two observable halves of the release. The body cancel is
 * what ends the request: `openAiFetch` unlinks the caller's abort signal
 * once the headers land, so after the open nothing else can close it.
 */
interface WatchedConsumer {
  consumer: StreamConsumer;
  /** How many times the consumer's own `finally` has run. */
  releases: () => number;
}

/**
 * A consumer shaped like `createOpenAiStreamConsumer`: it holds a reader
 * for the life of the stream, yields one chunk per read, and gives the
 * lock back in a `finally`. The lock matters — `body.cancel()` on a
 * stream that is still locked rejects, so only a release that closes this
 * generator *before* cancelling can reach the body.
 */
function watchedConsumer(): WatchedConsumer {
  let releases = 0;
  const consumer: StreamConsumer = {
    async *consume(body) {
      if (!body) return;
      const reader = body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          yield {
            delta: decoder.decode(next.value),
            reasoningDelta: "",
            done: false,
          };
        }
      } finally {
        releases += 1;
        reader.releaseLock();
      }
      yield { delta: "", reasoningDelta: "", done: true };
      return {
        content: "hi",
        reasoningContent: "",
        finishReason: "stop",
        modelId: "qwen-test",
        terminalObserved: true,
      };
    },
  };
  return { consumer, releases: () => releases };
}

interface OpenBody {
  response: Response;
  /** How many times the body was cancelled. */
  cancels: () => number;
}

/** A body that delivers `chunks` and then, unless `close`, never ends. */
function body(chunks: readonly string[], close: boolean): OpenBody {
  const encoder = new TextEncoder();
  let cancels = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
    cancel() {
      cancels += 1;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    cancels: () => cancels,
  };
}

function provider(open: OpenBody, consumer: StreamConsumer): OpenAiProvider {
  return new OpenAiProvider({
    id: "test",
    baseUrl: "https://example.invalid",
    apiKey: "",
    defaultChatModel: "qwen-test",
    fetchImpl: (async () => open.response) as unknown as typeof fetch,
    streamConsumer: consumer,
  });
}

/** The cancel is not awaited inside the generator, so let it land. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("OpenAiProvider.completeStream transport release", () => {
  it("closes the consumer and cancels the body when the generator is abandoned", async () => {
    const open = body(["one"], false);
    const watched = watchedConsumer();
    const stream = provider(open, watched.consumer).completeStream({
      prompt: "hi",
    });

    const first = await stream.next();
    expect(first.done).toBe(false);
    expect(watched.releases()).toBe(0);
    expect(open.cancels()).toBe(0);

    // The caller walks away mid-stream: a `break` out of its `for await`,
    // or an exception out of the consuming body, both of which reach this
    // generator as `.return()`.
    await stream.return(undefined as never);

    expect(watched.releases()).toBe(1);
    await tick();
    expect(open.cancels()).toBe(1);
  });

  it("releases the transport when the consuming loop throws back into the stream", async () => {
    const open = body(["one"], false);
    const watched = watchedConsumer();
    const stream = provider(open, watched.consumer).completeStream({
      prompt: "hi",
    });

    expect((await stream.next()).done).toBe(false);
    const failure = new Error("consumer blew up");
    // The error the caller is already seeing must survive the release —
    // a `.return()` that rejected while unwinding would replace it.
    await expect(stream.throw(failure)).rejects.toBe(failure);

    expect(watched.releases()).toBe(1);
    await tick();
    expect(open.cancels()).toBe(1);
  });

  it("leaves a fully drained stream to release itself, exactly once", async () => {
    const open = body(["one", "two"], true);
    const watched = watchedConsumer();
    const stream = provider(open, watched.consumer).completeStream({
      prompt: "hi",
    });

    const deltas: string[] = [];
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        expect(next.value.content).toBe("hi");
        break;
      }
      deltas.push(next.value.delta);
    }
    expect(deltas).toEqual(["one", "two"]);

    // The consumer reached its own `done`: it released itself, and the
    // block that covers an abandon must not fire a second time — nor
    // cancel a body that has already ended.
    await tick();
    expect(watched.releases()).toBe(1);
    expect(open.cancels()).toBe(0);
    await expect(stream.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});
