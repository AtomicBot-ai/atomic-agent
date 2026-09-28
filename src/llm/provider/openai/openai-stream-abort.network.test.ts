import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { classifyFailure } from "../../reliability/classify-failure.js";
import { OpenAiProvider } from "./openai-provider.js";

/**
 * End to end over a real socket: a provider that sends its headers and a
 * delta and then goes quiet must let go of the connection when the turn
 * is aborted. A cancelled `ReadableStream` is not the claim — a closed
 * TCP connection is, and only the server can testify to that.
 */

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

/** A server that streams one SSE delta and then says nothing more. */
async function startQuietSseServer() {
  let closedSockets = 0;
  const server = createServer((req, res) => {
    req.socket.once("close", () => {
      closedSockets += 1;
    });
    req.resume();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.write(
      `data: ${JSON.stringify({
        id: "gen-socket",
        model: "test-model",
        choices: [
          { index: 0, delta: { content: "hel" }, finish_reason: null },
        ],
      })}\n\n`,
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    closedSockets: () => closedSockets,
  };
}

/** Polls `predicate` until it holds or `ms` elapses. */
async function eventually(
  predicate: () => boolean,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

describe("an aborted openai stream over a real socket", () => {
  it("closes the connection instead of waiting for the body to die", async () => {
    const server = await startQuietSseServer();
    const provider = new OpenAiProvider({
      id: "primary",
      baseUrl: server.url,
      apiKey: "test-key",
      defaultChatModel: "test-model",
    });
    const controller = new AbortController();
    const stream = provider.completeStream({
      prompt: "hi",
      signal: controller.signal,
    });
    const first = await stream.next();
    expect(first.done).toBe(false);

    // The next read is parked inside the body with the server quiet.
    const pending = stream.next().then(
      () => ({ kind: "returned" as const }),
      (err: unknown) => ({ kind: "threw" as const, err }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.closedSockets()).toBe(0);

    const abortedAt = Date.now();
    controller.abort();
    const outcome = await Promise.race([
      pending,
      new Promise<{ kind: "unsettled" }>((resolve) =>
        setTimeout(() => resolve({ kind: "unsettled" }), 1_000),
      ),
    ]);

    expect(outcome.kind).toBe("threw");
    if (outcome.kind !== "threw") return;
    expect(Date.now() - abortedAt).toBeLessThan(1_000);
    expect(classifyFailure(outcome.err)).toBe("cancelled");
    // The socket, not the stream object: a body left unread keeps the
    // connection — and an openai-compatible local server's llama.cpp
    // slot with it — until the process exits.
    expect(await eventually(() => server.closedSockets() > 0, 2_000)).toBe(
      true,
    );
  });
});
