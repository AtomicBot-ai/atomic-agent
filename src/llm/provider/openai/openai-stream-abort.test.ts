import { getEventListeners } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifyFailure } from "../../reliability/classify-failure.js";
import { shouldAdvance } from "../../fallback/should-advance.js";
import { createOpenAiStreamConsumer } from "./openai-stream-consumer.js";
import { OpenAiProvider } from "./openai-provider.js";

/**
 * How long after an abort the read is allowed to settle. Generous by two
 * orders of magnitude — the point of the bound is that it is a bound at
 * all: before the signal was raced, this never settled until undici's
 * ~300 s body timeout killed the socket.
 */
const SETTLE_BUDGET_MS = 250;

function frame(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const HELLO = frame({
  id: "gen-quiet",
  model: "qwen-test",
  choices: [
    { index: 0, delta: { role: "assistant", content: "hel" }, finish_reason: null },
  ],
});

/**
 * A body that delivers `HELLO` and then goes quiet: its second `pull`
 * never resolves, which is what a provider that stops sending mid-stream
 * looks like to a reader. `highWaterMark: 0` so nothing is pulled ahead
 * of the reader, and the `cancel` count is what proves the body was
 * closed — exactly once.
 */
function quietBody(): {
  body: ReadableStream<Uint8Array>;
  state: { pulls: number; cancels: number; reason: unknown };
} {
  const encoder = new TextEncoder();
  const state = { pulls: 0, cancels: 0, reason: undefined as unknown };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls += 1;
        if (state.pulls === 1) {
          controller.enqueue(encoder.encode(HELLO));
          return;
        }
        return new Promise<void>(() => {});
      },
      cancel(reason) {
        state.cancels += 1;
        state.reason = reason;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, state };
}

/**
 * A body that hands over `parts` one read at a time and then closes, and
 * whose `cancel` never settles — a socket teardown that goes nowhere. The
 * consumer must not await it.
 */
function scriptedBody(parts: readonly string[]): {
  body: ReadableStream<Uint8Array>;
  state: { cancels: number; reason: unknown };
} {
  const encoder = new TextEncoder();
  const state = { cancels: 0, reason: undefined as unknown };
  let sent = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const part = parts[sent];
        sent += 1;
        if (part === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(part));
      },
      cancel(reason) {
        state.cancels += 1;
        state.reason = reason;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, state };
}

/** How many `abort` listeners the consumer has left on a turn's signal. */
function abortListeners(signal: AbortSignal): number {
  return getEventListeners(signal as never, "abort").length;
}

/** Let every pending microtask and timer callback run. */
async function settleTicks(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

type ParkedOutcome =
  | { kind: "threw"; err: unknown; settledInMs: number }
  | { kind: "returned"; settledInMs: number }
  /** The abort never reached the read: the defect this file is about. */
  | { kind: "unsettled"; settledInMs: number };

/**
 * Ask for the next value, let the read park inside the quiet body, and
 * only then abort — the ordering the defect lived in. An abort raised
 * *before* the read starts is caught by the loop's own head check and
 * proves nothing about a stream that has already gone quiet.
 */
async function abortAParkedRead(
  next: Promise<unknown>,
  controller: AbortController,
  reason?: unknown,
): Promise<ParkedOutcome> {
  type Settled =
    | { kind: "threw"; err: unknown }
    | { kind: "returned" }
    | { kind: "unsettled" };
  const pending: Promise<Settled> = next.then(
    () => ({ kind: "returned" }) as Settled,
    (err: unknown) => ({ kind: "threw", err }) as Settled,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const abortedAt = Date.now();
  controller.abort(reason);
  const settled = await Promise.race([
    pending,
    new Promise<Settled>((resolve) =>
      setTimeout(() => resolve({ kind: "unsettled" }), SETTLE_BUDGET_MS),
    ),
  ]);
  return { ...settled, settledInMs: Date.now() - abortedAt };
}

describe("openai stream consumer: abort on a quiet stream", () => {
  let unhandled: unknown[] = [];
  const collect = (err: unknown): void => {
    unhandled.push(err);
  };

  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", collect);
  });

  afterEach(() => {
    process.off("unhandledRejection", collect);
  });

  it("settles the read within the abort instead of at the provider's timeout", async () => {
    const { body, state } = quietBody();
    const controller = new AbortController();
    const iterator = createOpenAiStreamConsumer("delta_reasoning").consume(
      body,
      controller.signal,
    );
    // One delta, then silence: the stream is committed and parked inside
    // `reader.read()` with nothing left to wake it.
    expect((await iterator.next()).value).toEqual({
      delta: "hel",
      reasoningDelta: "",
      done: false,
    });

    const outcome = await abortAParkedRead(iterator.next(), controller);

    // Not "eventually": before the signal was raced this stayed
    // unsettled until the transport died on its own.
    expect(outcome.kind).not.toBe("unsettled");
    expect(outcome.settledInMs).toBeLessThan(SETTLE_BUDGET_MS);
    // A cancelled turn fails as a cancellation: `signal.reason` is the
    // `AbortError` the classifier reads, so the fallback chain does not
    // mistake Esc for a dead provider and restart the completion.
    expect(outcome.kind).toBe("threw");
    if (outcome.kind !== "threw") return;
    expect(outcome.err).toBe(controller.signal.reason);
    expect(classifyFailure(outcome.err)).toBe("cancelled");
    expect(shouldAdvance(outcome.err).advance).toBe(false);
    // The socket does not stay open behind us, and it is closed once.
    expect(state.cancels).toBe(1);
    expect(body.locked).toBe(false);

    await settleTicks();
    // The read this loop walked away from must not surface as an
    // unhandled rejection: cancelling the body resolves it as `done`,
    // where releasing the lock first would reject it with a `TypeError`.
    expect(unhandled).toEqual([]);
  });

  it("stops before touching the body when the signal is already aborted", async () => {
    const { body, state } = quietBody();
    const controller = new AbortController();
    controller.abort();
    const iterator = createOpenAiStreamConsumer("delta_reasoning").consume(
      body,
      controller.signal,
    );
    await expect(iterator.next()).rejects.toBe(controller.signal.reason);
    expect(state.pulls).toBe(0);
    expect(state.cancels).toBe(1);
    expect(body.locked).toBe(false);
    await settleTicks();
    expect(unhandled).toEqual([]);
  });

  it("carries the generation id on the cancellation", async () => {
    // Whatever streamed before Esc was billed under that id; a cancelled
    // turn's trace row can still name the generation.
    const { body } = quietBody();
    const controller = new AbortController();
    const iterator = createOpenAiStreamConsumer("delta_reasoning").consume(
      body,
      controller.signal,
    );
    await iterator.next();
    const outcome = await abortAParkedRead(
      iterator.next(),
      controller,
      new Error("user pressed esc"),
    );
    expect(outcome.kind).toBe("threw");
    if (outcome.kind !== "threw") return;
    expect((outcome.err as { generationId?: unknown }).generationId).toBe(
      "gen-quiet",
    );
  });
});

describe("OpenAiProvider.completeStream: abort on a quiet stream", () => {
  it("ends the completion as a cancellation without reopening the stream", async () => {
    const { body, state } = quietBody();
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );
    const provider = new OpenAiProvider({
      id: "test",
      baseUrl: "https://example.invalid",
      apiKey: "",
      defaultChatModel: "qwen-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const controller = new AbortController();
    const stream = provider.completeStream({
      prompt: "hi",
      signal: controller.signal,
    });
    expect((await stream.next()).done).toBe(false);

    const outcome = await abortAParkedRead(stream.next(), controller);

    expect(outcome.settledInMs).toBeLessThan(SETTLE_BUDGET_MS);
    expect(outcome.kind).toBe("threw");
    if (outcome.kind !== "threw") return;
    expect(classifyFailure(outcome.err)).toBe("cancelled");
    expect(shouldAdvance(outcome.err).advance).toBe(false);
    // A cancelled completion is never reopened on this link, and never
    // handed to the next one.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(state.cancels).toBe(1);
  });
});

describe("openai stream consumer: the abort listener's lifetime", () => {
  it("leaves nothing attached to the turn's signal when the stream drains", async () => {
    const { body } = scriptedBody([
      HELLO,
      frame({
        id: "gen-quiet",
        model: "qwen-test",
        choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }],
      }),
      "data: [DONE]\n\n",
    ]);
    const controller = new AbortController();
    const iterator = createOpenAiStreamConsumer("delta_reasoning").consume(
      body,
      controller.signal,
    );
    for (;;) {
      if ((await iterator.next()).done) break;
    }
    // A turn's signal outlives one completion — the step executor reuses it
    // for every link of the fallback chain and every later step — so a
    // listener this generator forgets to take off is held for the turn.
    expect(abortListeners(controller.signal)).toBe(0);
  });

  it("leaves nothing attached after the abort wakes a parked read", async () => {
    const { body } = quietBody();
    const controller = new AbortController();
    const iterator = createOpenAiStreamConsumer("delta_reasoning").consume(
      body,
      controller.signal,
    );
    await iterator.next();
    await abortAParkedRead(iterator.next(), controller);
    expect(abortListeners(controller.signal)).toBe(0);
  });

  it("leaves nothing attached when the signal was already aborted", async () => {
    const { body } = quietBody();
    const controller = new AbortController();
    controller.abort();
    const iterator = createOpenAiStreamConsumer("delta_reasoning").consume(
      body,
      controller.signal,
    );
    await expect(iterator.next()).rejects.toBe(controller.signal.reason);
    expect(abortListeners(controller.signal)).toBe(0);
  });

  it("registers the listener `once`, so an abandoned generator's is gone after the abort", async () => {
    // `OpenAiProvider.completeStream` pumps `stream.next()` by hand with no
    // `finally` that returns the consumer, so a caller that breaks out of
    // the loop abandons this generator with its `finally` never run and its
    // listener still attached — the same way main leaves the reader lock and
    // the socket behind (#518 fixes the abandon itself). `{ once: true }` is
    // what keeps that bounded: the listeners all come off the moment the
    // turn aborts, instead of accumulating on a signal that outlives them.
    const controller = new AbortController();
    const iterators = [0, 1, 2].map(() => {
      const { body } = quietBody();
      return createOpenAiStreamConsumer("delta_reasoning").consume(
        body,
        controller.signal,
      );
    });
    for (const iterator of iterators) await iterator.next();
    expect(abortListeners(controller.signal)).toBe(3);
    controller.abort();
    await settleTicks();
    expect(abortListeners(controller.signal)).toBe(0);
  });
});

describe("openai stream consumer: how the body is closed on an abort", () => {
  it("cancels with the abort reason, so a routing provider stops the generation", async () => {
    // OpenRouter ends the generation — and the billing — when its client
    // goes away, and the reason is what names why. A bare `cancel()` closes
    // the socket but says nothing.
    const { body, state } = quietBody();
    const controller = new AbortController();
    const iterator = createOpenAiStreamConsumer("delta_reasoning").consume(
      body,
      controller.signal,
    );
    await iterator.next();
    const reason = new Error("user pressed esc");
    await abortAParkedRead(iterator.next(), controller, reason);
    expect(state.cancels).toBe(1);
    expect(state.reason).toBe(reason);
  });

  it("does not wait for a body whose cancel never settles", async () => {
    // The cancel is `void`ed for this: `ReadableStreamCancel` closes the
    // stream before it calls the source's cancel algorithm, so awaiting it
    // buys nothing and turns a socket teardown that goes nowhere into a
    // consumer that cannot walk away.
    const encoder = new TextEncoder();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(encoder.encode(HELLO));
            return;
          }
          return new Promise<void>(() => {});
        },
        cancel() {
          return new Promise<void>(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const iterator = createOpenAiStreamConsumer("delta_reasoning").consume(
      body,
      controller.signal,
    );
    await iterator.next();
    const unhandled: unknown[] = [];
    const collect = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on("unhandledRejection", collect);
    try {
      const outcome = await abortAParkedRead(iterator.next(), controller);
      expect(outcome.kind).toBe("threw");
      expect(outcome.settledInMs).toBeLessThan(SETTLE_BUDGET_MS);
      await settleTicks();
      // The cancel promise stays pending forever; nothing must surface it.
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", collect);
    }
  });
});

describe("openai stream consumer: an abort that lands between chunks", () => {
  it("throws on the next step without reading another byte", async () => {
    // The wake-up resolver only exists while a read is outstanding, so an
    // abort that arrives while this generator is suspended at a `yield`
    // finds nothing to wake. The head of the loop is what honours it, one
    // step later — and it must honour it *before* the read, or a quiet
    // stream parks again with the turn already cancelled.
    const { body, state } = quietBody();
    const controller = new AbortController();
    const iterator = createOpenAiStreamConsumer("delta_reasoning").consume(
      body,
      controller.signal,
    );
    expect((await iterator.next()).value).toEqual({
      delta: "hel",
      reasoningDelta: "",
      done: false,
    });
    const reason = new Error("esc between chunks");
    controller.abort(reason);
    await expect(iterator.next()).rejects.toBe(reason);
    // Never went back to the body: one pull, and it was closed on the way
    // out with the reason.
    expect(state.pulls).toBe(1);
    expect(state.cancels).toBe(1);
    expect(state.reason).toBe(reason);
    expect(body.locked).toBe(false);
  });
});

/**
 * Only meaningful with a forced GC, so it runs under
 * `NODE_OPTIONS=--expose-gc npx vitest run …` and skips otherwise rather
 * than reporting a number that means nothing.
 */
const forceGc = (globalThis as { gc?: () => void }).gc;

describe.skipIf(!forceGc)("openai stream consumer: per-read retention", () => {
  it("does not grow the heap with the read count on a stream nobody aborts", async () => {
    // An openai-compatible local server sends one SSE frame per token, one
    // read each, and the signal for a turn nobody cancels never settles.
    // Racing a single long-lived promise leaves every iteration's
    // `Promise.race` reaction on it for the life of the generator: ~550 B a
    // read, ~18 MB over the 33,678-token completion this consumer's
    // fabrication watcher exists for, in the process holding the model.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(encoder.encode(HELLO));
        },
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const iterator = createOpenAiStreamConsumer("delta_reasoning").consume(
      body,
      controller.signal,
    );
    forceGc?.();
    const before = process.memoryUsage().heapUsed;
    for (let read = 0; read < 60_000; read += 1) await iterator.next();
    forceGc?.();
    const grownMb = (process.memoryUsage().heapUsed - before) / 1e6;
    controller.abort();
    await iterator.next().catch(() => undefined);
    // 3.9 MB with a fresh promise per read (4.1 MB for the loop before the
    // race existed at all), 37.0 MB with one shared promise. The bound is
    // deliberately nowhere near either.
    expect(grownMb).toBeLessThan(12);
  }, 60_000);
});
