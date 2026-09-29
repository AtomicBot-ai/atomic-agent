import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CompletionResult,
  StreamChunk,
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
 * did not wait for another frame" assertable.
 *
 * The two non-default cancels are the shapes that can hurt: `"throw"` is
 * the one that could turn a clean user abort into a turn error, and
 * `"never-settles"` is the one that could wedge the generator (and so the
 * turn's teardown) if the cancel were awaited.
 */
function trackedBody(
  frames: readonly string[],
  onCancel: "settle" | "throw" | "never-settles" = "settle",
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
      cancel(reason): void | Promise<void> {
        state.cancels += 1;
        state.reason = reason;
        if (onCancel === "throw") throw new Error("socket already gone");
        if (onCancel === "never-settles") return new Promise<void>(() => {});
        return undefined;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, state };
}

/** True if `promise` settles inside `ms`, without leaving a live timer. */
async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
 * mid-stream. The consumer fails its next step with the abort reason
 * (a cancelled turn must not hand back the prefix as a completion) — and
 * `openAiFetch`
 * has already detached the caller's signal from the fetch's own
 * controller, so the only thing left that can close the socket is a
 * cancel of this body.
 */
describe("openai stream consumer: an aborted turn releases the body", () => {
  it("cancels the body once, unlocks it, and fails with the abort reason", async () => {
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

    await expect(iterator.next()).rejects.toBe(controller.signal.reason);
    // The throw happens before the next read, so the abort does not wait
    // on the provider for one more frame.
    expect(state.pulled).toBe(1);
    expect(body.locked).toBe(false);
    expect(state.cancels).toBe(1);
    expect(state.reason).toBe(controller.signal.reason);

    const last = await iterator.next();
    expect(last.done).toBe(true);
    // Still 1 on the way out. This cannot fail — a second cancel of the
    // same stream never reaches the source — so it pins the count, not
    // the absence of a second call.
    expect(state.cancels).toBe(1);
  });

  it("swallows a cancel that rejects instead of failing the turn", async () => {
    const { body, state } = trackedBody([contentFrame("par")], "throw");
    const controller = new AbortController();
    const iterator = createOpenAiStreamConsumer("auto").consume(
      body,
      controller.signal,
    );

    expect((await iterator.next()).done).toBe(false);
    controller.abort();

    // The cancel's own rejection is swallowed: the turn fails with the
    // abort reason, never with the transport's error.
    await expect(iterator.next()).rejects.toBe(controller.signal.reason);
    expect(state.cancels).toBe(1);
  });

  it("does not wait for a cancel the transport never settles", async () => {
    const { body, state } = trackedBody(
      [contentFrame("par"), contentFrame("tial")],
      "never-settles",
    );
    const controller = new AbortController();
    const iterator = createOpenAiStreamConsumer("auto").consume(
      body,
      controller.signal,
    );

    expect((await iterator.next()).done).toBe(false);
    controller.abort();

    // Awaiting the cancel would suspend the generator here for as long as
    // the source holds its promise, and an `await` is exactly what a
    // `stream.return()` teardown cannot resume — so a body that never
    // acknowledges the cancel would wedge the turn's teardown, not just
    // this consumer.
    expect(
      await settlesWithin(iterator.next().catch(() => undefined), 250),
    ).toBe(true);
    expect(state.cancels).toBe(1);
    expect(body.locked).toBe(false);
  });
});

/**
 * The fakes above are real `ReadableStream`s, so the lock, the cancel
 * rejection and the read-after-cancel are genuine platform semantics —
 * but they can only show that `cancel()` was called. The claim this change
 * actually makes is that the *request ends*, so prove it over a socket:
 * a local server, real `fetch`, and the server's own `close` event.
 */
describe("openai stream consumer over a real socket", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("closes the HTTP response when the turn is aborted", async () => {
    let responseClosed = false;
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(contentFrame("par"));
      // Keep producing, so nothing but our cancel can end the response.
      const tick = setInterval(() => res.write(contentFrame("more")), 5);
      res.on("close", () => {
        responseClosed = true;
        clearInterval(tick);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/`);
    if (!res.body) throw new Error("no body");
    const controller = new AbortController();
    const iterator = createOpenAiStreamConsumer("auto").consume(
      res.body,
      controller.signal,
    );

    expect((await iterator.next()).done).toBe(false);
    expect(responseClosed).toBe(false);

    controller.abort();
    await expect(iterator.next()).rejects.toBe(controller.signal.reason);

    await vi.waitFor(() => expect(responseClosed).toBe(true));
  });
});

describe("OpenAiProvider: a stream the user aborted", () => {
  it("releases the transport and fails as a cancellation", async () => {
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
    // Fails with the abort reason itself, which classifies as
    // `cancelled`: a cancel that surfaced as a transport failure would
    // make `shouldAdvance` report a provider-down signal and the fallback
    // chain would start the very completion the user just stopped.
    await expect(drainProvider(stream)).rejects.toBe(controller.signal.reason);

    expect(tracked.state.cancels).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
