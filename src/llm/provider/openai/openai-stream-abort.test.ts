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
