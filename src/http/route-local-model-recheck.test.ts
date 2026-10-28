import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

/** A port that was just bound and released. */
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

/** Something that is not a model server: 404 on every path. */
async function startNotAModelServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const srv: Server = createServer((_req, res) => {
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const address = srv.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => srv.close(() => resolve())),
  };
}

describe("POST /api/local-model/recheck (ATO-873)", () => {
  let harness: Harness | null = null;
  let server: { url: string; stop: () => Promise<void> } | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
    if (server) await server.stop();
    server = null;
  });

  it("says the configured address answers but is not a model server", async () => {
    server = await startNotAModelServer();
    harness = await startTestHarness({ localModelsUrl: server.url });

    const res = await fetch(`${harness.baseUrl}/api/local-model/recheck`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      verdict: "not_model_server",
      ok: false,
      portHint: null,
    });
    expect(body["message"]).toContain("isn't a model server");
  });

  it("says nothing answers on a closed port", async () => {
    const url = `http://127.0.0.1:${await closedPort()}`;
    harness = await startTestHarness({ localModelsUrl: url });

    const res = await fetch(`${harness.baseUrl}/api/local-model/recheck`, { method: "POST" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ verdict: "unreachable", ok: false });
    expect(String(body["url"])).toContain(url.replace("http://", ""));
  });

  it("sits behind the API key", async () => {
    harness = await startTestHarness({
      apiKey: "secret",
      localModelsUrl: `http://127.0.0.1:${await closedPort()}`,
    });
    const res = await fetch(`${harness.baseUrl}/api/local-model/recheck`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});
