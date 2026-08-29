import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

/** A port that was just bound and released — as closed as a port gets. */
async function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createTcpServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Minimal llama-server imitation: answers `/health` the way llama.cpp does. */
async function startFakeLlama(): Promise<{ url: string; stop: () => Promise<void> }> {
  const srv: Server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const address = srv.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => srv.close(() => resolve())),
  };
}

describe("GET /health", () => {
  let harness: Harness | null = null;
  let fakeLlama: { url: string; stop: () => Promise<void> } | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
    if (fakeLlama) await fakeLlama.stop();
    fakeLlama = null;
  });

  it("answers fast and says degraded when llama is down", async () => {
    harness = await startTestHarness({
      localModelsUrl: `http://127.0.0.1:${await closedPort()}`,
    });

    const started = Date.now();
    const res = await fetch(`${harness.baseUrl}/health`);
    const elapsed = Date.now() - started;
    const body = (await res.json()) as {
      status: string;
      llama: { reachable: boolean; error: string | null };
    };

    // One probe, no retry ladder: the full ladder was 15.5 s of backoff,
    // far beyond any orchestrator's patience. A refused connection fails
    // in milliseconds; five seconds is a generous ceiling.
    expect(elapsed).toBeLessThan(5000);
    // Sidecar alive → 200 by default; the body tells the truth about llama.
    expect(res.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.llama.reachable).toBe(false);
  });

  it("returns 503 for ?strict=1 when llama is down", async () => {
    harness = await startTestHarness({
      localModelsUrl: `http://127.0.0.1:${await closedPort()}`,
    });

    const res = await fetch(`${harness.baseUrl}/health?strict=1`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("degraded");
  });

  it("reports ok — strict or not — when llama answers", async () => {
    fakeLlama = await startFakeLlama();
    harness = await startTestHarness({ localModelsUrl: fakeLlama.url });

    const plain = await fetch(`${harness.baseUrl}/health`);
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as { status: string }).status).toBe("ok");

    const strict = await fetch(`${harness.baseUrl}/health?strict=1`);
    expect(strict.status).toBe(200);
    expect(((await strict.json()) as { status: string }).status).toBe("ok");
  });
});
