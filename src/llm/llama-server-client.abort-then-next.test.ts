import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

import { LlamaServerClient } from "./llama-server-client.js";

/**
 * ATO-1357 / issue #490, the client half.
 *
 * Field report: a Fusion worker on a local llama-server was cut off at
 * its time limit, and from then on no worker's request reached the
 * server — nothing in its log, `/health` answering, every slot idle —
 * until the agent process was restarted.
 *
 * These tests drive the real `fetch` against a real socket and pin the
 * one thing that report says broke: after a stream is aborted, at any
 * phase, the socket it held is closed (so llama.cpp can free its slot)
 * and the NEXT request is on the wire at once. They also pin the phase
 * trace, which is what a field log needs to tell "never sent" from
 * "sent and never answered".
 */

interface Arrival {
  path: string;
  at: number;
  /** Resolves when the server sees this request's connection close. */
  closed: Promise<void>;
  res: http.ServerResponse;
}

type Behaviour = "hold" | "first-byte-then-hold" | "answer";

async function fakeLlamaServer(): Promise<{
  base: string;
  arrivals: Arrival[];
  /** How the NEXT /completion is handled. */
  next: (behaviour: Behaviour) => void;
  /** Resolves on the n-th arrival (1-based). */
  arrival: (n: number) => Promise<Arrival>;
  close: () => Promise<void>;
}> {
  const arrivals: Arrival[] = [];
  const queue: Behaviour[] = [];
  const waiters: Array<{ n: number; resolve: (a: Arrival) => void }> = [];
  const server = http.createServer((req, res) => {
    // Drain the POST body so the request is complete on our side.
    req.resume();
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    res.on("close", () => markClosed());
    const arrival: Arrival = { path: req.url ?? "", at: Date.now(), closed, res };
    arrivals.push(arrival);
    for (const waiter of waiters.splice(0)) {
      if (arrivals.length >= waiter.n) waiter.resolve(arrivals[waiter.n - 1]!);
      else waiters.push(waiter);
    }
    const behaviour = queue.shift() ?? "answer";
    if (behaviour === "hold") return; // prompt eval that never ends
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (behaviour === "first-byte-then-hold") {
      res.write('data: {"content":"he","stop":false}\n\n');
      return; // a generation that stalls mid-reply
    }
    res.end(
      'data: {"content":"ok","stop":false}\n\n' +
        'data: {"content":"","stop":true,"id_slot":0}\n\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    arrivals,
    next: (behaviour) => queue.push(behaviour),
    arrival: (n) =>
      arrivals.length >= n
        ? Promise.resolve(arrivals[n - 1]!)
        : new Promise((resolve) => waiters.push({ n, resolve })),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    }),
  ]);
}

interface LogLine {
  message: string;
  context: Record<string, unknown> | undefined;
}

describe("LlamaServerClient after an aborted stream (ATO-1357)", () => {
  const original = getGlobalDispatcher();
  let server: Awaited<ReturnType<typeof fakeLlamaServer>>;
  let logs: LogLine[];
  let client: LlamaServerClient;

  beforeEach(async () => {
    // A pool of our own, so nothing another test left on the global one
    // can make this pass or fail.
    setGlobalDispatcher(new Agent({}));
    server = await fakeLlamaServer();
    logs = [];
    client = new LlamaServerClient({
      baseUrl: server.base,
      progressWatch: false,
      completionRetries: 0,
      // Our deadlines must not be what ends anything here.
      requestTimeoutMs: 60_000,
      firstTokenTimeoutMs: 60_000,
      streamTotalTimeoutMs: 60_000,
      logger: {
        debug: (message: string, context?: Record<string, unknown>) => {
          logs.push({ message, context });
        },
      },
    });
  });

  afterEach(async () => {
    await server.close();
    setGlobalDispatcher(original);
  });

  async function secondRequestGoesOutAtOnce(): Promise<void> {
    server.next("answer");
    const before = server.arrivals.length;
    const sentAt = Date.now();
    const stream = client.completeStream({ prompt: "next", sessionId: "w-2" });
    const first = await within(stream.next(), 2_000, "the next request's first chunk");
    expect(first.done).toBe(false);
    expect(server.arrivals.length).toBe(before + 1);
    // On the wire at once, not after a queue budget.
    expect(server.arrivals[before]!.at - sentAt).toBeLessThan(1_000);
    for (;;) {
      const step = await stream.next();
      if (step.done) break;
    }
  }

  it("closes the socket and sends the next request at once when aborted before any header", async () => {
    server.next("hold");
    const cut = new AbortController();
    const stream = client.completeStream({ prompt: "long", sessionId: "w-1", slotId: 0, signal: cut.signal });
    const pending = stream.next();
    pending.catch(() => undefined);
    const first = await within(server.arrival(1), 2_000, "the first request");

    // The worker's time limit fires while the server is still reading
    // the prompt.
    cut.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await expect(pending).rejects.toBeDefined();
    // The server sees the connection go: that is what frees a llama.cpp slot.
    await within(first.closed, 2_000, "the aborted request's socket to close");

    await secondRequestGoesOutAtOnce();

    const ended = logs.find((line) => line.message === "llama stream: ended before the body");
    expect(ended?.context).toMatchObject({
      sessionId: "w-1",
      slotId: 0,
      phase: "sending",
      callerAborted: true,
      deadline: null,
    });
    const sent = logs.filter((line) => line.message === "llama stream: request sent");
    expect(sent.map((line) => line.context?.sessionId)).toEqual(["w-1", "w-2"]);
  });

  it("closes the socket and sends the next request at once when aborted mid-reply", async () => {
    server.next("first-byte-then-hold");
    const cut = new AbortController();
    const stream = client.completeStream({ prompt: "long", sessionId: "w-1", signal: cut.signal });
    const chunk = await within(stream.next(), 2_000, "the first chunk");
    expect(chunk.done).toBe(false);
    const pending = stream.next();
    pending.catch(() => undefined);

    cut.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await expect(pending).rejects.toBeDefined();
    await within(server.arrivals[0]!.closed, 2_000, "the aborted stream's socket to close");

    await secondRequestGoesOutAtOnce();

    const closed = logs.find(
      (line) => line.message === "llama stream: closed" && line.context?.sessionId === "w-1",
    );
    expect(closed?.context).toMatchObject({
      outcome: "error",
      phase: "streaming",
      callerAborted: true,
    });
    expect(logs.some((line) => line.message === "llama stream: first byte")).toBe(true);
  });

  it("closes the socket and sends the next request at once when the consumer walks away", async () => {
    server.next("first-byte-then-hold");
    const stream = client.completeStream({ prompt: "long", sessionId: "w-1" });
    await within(stream.next(), 2_000, "the first chunk");
    // An abandon with no signal at all: the generator's own release is
    // the only thing that can close this socket.
    await stream.return(undefined as never);
    await within(server.arrivals[0]!.closed, 2_000, "the abandoned stream's socket to close");

    await secondRequestGoesOutAtOnce();

    const closed = logs.find(
      (line) => line.message === "llama stream: closed" && line.context?.sessionId === "w-1",
    );
    expect(closed?.context).toMatchObject({ outcome: "abandoned", callerAborted: false });
  });

  it("sends a burst of requests after several aborted ones without any of them waiting", async () => {
    // Three cut-off workers in a row, then three more: the process must
    // never accumulate anything that makes a later request wait.
    for (let i = 0; i < 3; i += 1) {
      server.next("hold");
      const cut = new AbortController();
      const stream = client.completeStream({ prompt: "long", sessionId: `cut-${i}`, signal: cut.signal });
      const pending = stream.next();
      pending.catch(() => undefined);
      const seen = await within(server.arrival(i + 1), 2_000, `cut request ${i}`);
      cut.abort();
      await expect(pending).rejects.toBeDefined();
      await within(seen.closed, 2_000, `cut request ${i} socket close`);
    }
    for (let i = 0; i < 3; i += 1) {
      await secondRequestGoesOutAtOnce();
    }
    expect(server.arrivals).toHaveLength(6);
  });
});
