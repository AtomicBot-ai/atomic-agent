import { describe, expect, it, vi } from "vitest";

import type {
  CompletionResult,
  StreamChunk,
  StreamFinalResult,
} from "../completion-types.js";
import { createOpenAiStreamConsumer } from "./openai-stream-consumer.js";
import { OpenAiProvider } from "./openai-provider.js";

function frame(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function contentFrame(content: string): string {
  return frame({
    model: "qwen-test",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
}

/**
 * A body served one frame per read, recording every cancel it is given.
 * `highWaterMark: 0` so nothing is pulled ahead of the reader — `pulled`
 * is exactly what the consumer read, which is what makes "the abort break
 * did not wait for another frame" assertable. `failCancel` makes the
 * underlying cancel throw: the one shape that could turn a clean user
 * abort into a turn error.
 */
function trackedBody(
  frames: readonly string[],
  failCancel = false,
): {
  body: ReadableStream<Uint8Array>;
  state: { pulled: number; cancels: number; reason: unknown };
} {
  const encoder = new TextEncoder();
  const state = { pulled: 0, cancels: 0, reason: undefined as unknown };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = frames[state.pulled];
        if (next === undefined) {
          controller.close();
          return;
        }
        state.pulled += 1;
        controller.enqueue(encoder.encode(next));
      },
      cancel(reason) {
        state.cancels += 1;
        state.reason = reason;
        if (failCancel) throw new Error("socket already gone");
      },
    },
    { highWaterMark: 0 },
  );
  return { body, state };
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
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

async function drainProvider(
  stream: AsyncGenerator<StreamChunk, CompletionResult, void>,
): Promise<CompletionResult> {
  for (;;) {
    const next = await stream.next();
    if (next.done) return next.value;
  }
}

/**
 * Esc+1, `/abort` and Ctrl+C all reach the provider as an aborted signal
 * mid-stream. The consumer leaves its read loop on that signal, so from
 * every layer above it the stream drained normally — and `openAiFetch`
 * has already detached the caller's signal from the fetch's own
 * controller, so the only thing left that can close the socket is a
 * cancel of this body.
 */
describe("openai stream consumer: an aborted turn releases the body", () => {
  it("cancels the body once, unlocks it, and still ends as a stream end", async () => {
    const { body, state } = trackedBody([
      contentFrame("par"),
      contentFrame("tial"),
    ]);
    const controller = new AbortController();
    const iterator = createOpenAiStreamConsumer("auto").consume(
      body,
      controller.signal,
    );

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect((first.value as StreamChunk).delta).toBe("par");
    expect(state.cancels).toBe(0);

    controller.abort();

    const terminal = await iterator.next();
    expect(terminal.done).toBe(false);
    expect((terminal.value as StreamChunk).done).toBe(true);
    // The break happens before the next read, so the abort does not wait
    // on the provider for one more frame.
    expect(state.pulled).toBe(1);
    expect(body.locked).toBe(false);
    expect(state.cancels).toBe(1);
    expect(state.reason).toBe(controller.signal.reason);

    const last = await iterator.next();
    expect(last.done).toBe(true);
    const final = last.value as StreamFinalResult;
    expect(final.content).toBe("par");
    // A stream nobody finished has no provider terminal event.
    expect(final.terminalObserved).toBe(false);
    // Exactly once: the release is not repeated on the way out.
    expect(state.cancels).toBe(1);
  });

  it("swallows a cancel that rejects instead of failing the turn", async () => {
    const { body, state } = trackedBody([contentFrame("par")], true);
    const controller = new AbortController();
    const iterator = createOpenAiStreamConsumer("auto").consume(
      body,
      controller.signal,
    );

    expect((await iterator.next()).done).toBe(false);
    controller.abort();

    const terminal = await iterator.next();
    expect((terminal.value as StreamChunk).done).toBe(true);
    const last = await iterator.next();
    expect(last.done).toBe(true);
    expect((last.value as StreamFinalResult).content).toBe("par");
    expect(state.cancels).toBe(1);
  });
});

describe("OpenAiProvider: a stream the user aborted", () => {
  it("releases the transport and still returns the partial completion", async () => {
    const tracked = trackedBody([contentFrame("par"), contentFrame("tial")]);
    const fetchImpl = vi.fn().mockResolvedValueOnce(sseResponse(tracked.body));
    const controller = new AbortController();

    const stream = provider(fetchImpl).completeStream({
      prompt: "hi",
      signal: controller.signal,
    });
    const first = await stream.next();
    expect(first.done).toBe(false);

    controller.abort();
    // Must not throw: a cancel that surfaced as a transport failure would
    // make `shouldAdvance` report a provider-down signal and the fallback
    // chain would start the very completion the user just stopped.
    const result = await drainProvider(stream);

    expect(tracked.state.cancels).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.content).toBe("par");
  });
});
