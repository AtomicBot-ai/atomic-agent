import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { probeServeHealth } from "./serve-probe.js";

let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map((srv) => new Promise<void>((done) => srv.close(() => done()))),
  );
  servers = [];
});

/** A server answering `/health` with `body`, on the given host. */
async function startHealth(body: unknown, host = "127.0.0.1"): Promise<number> {
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  servers.push(srv);
  await new Promise<void>((done) => srv.listen(0, host, done));
  const address = srv.address();
  return typeof address === "object" && address ? address.port : 0;
}

/** A port that was just bound and released — as closed as a port gets. */
async function closedPort(): Promise<number> {
  return new Promise((done) => {
    const srv = createTcpServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => done(port));
    });
  });
}

describe("probeServeHealth", () => {
  it("reads the health body off a live server", async () => {
    const port = await startHealth({ runtime: "atomic-agent", pid: 7, ppid: 1, busyTurns: 0 });
    const out = await probeServeHealth({ host: "127.0.0.1", port });
    expect(out).toEqual({
      kind: "health",
      health: { runtime: "atomic-agent", pid: 7, ppid: 1, busyTurns: 0 },
    });
  });

  it("reports an empty body — nobody home — when the port is closed", async () => {
    // A refused connection means the port is genuinely free, so the
    // caller is right to treat the record as stale.
    const out = await probeServeHealth({ host: "127.0.0.1", port: await closedPort() });
    expect(out).toEqual({ kind: "health", health: {} });
  });

  it("brackets an IPv6 literal instead of building an unparseable URL", async () => {
    // Unbracketed this is `http://::1:PORT/health`, which throws in the
    // URL parser — and a caught throw used to read as "nobody home",
    // silently dropping the record of a perfectly live server.
    const port = await startHealth({ runtime: "atomic-agent", pid: 9 }, "::1");
    const out = await probeServeHealth({ host: "::1", port });
    expect(out).toEqual({ kind: "health", health: { runtime: "atomic-agent", pid: 9 } });
  });

  it("maps a wildcard bind to loopback", async () => {
    const port = await startHealth({ runtime: "atomic-agent", pid: 11 });
    expect(await probeServeHealth({ host: "0.0.0.0", port })).toEqual({
      kind: "health",
      health: { runtime: "atomic-agent", pid: 11 },
    });
  });

  it("says unreachable — never stale — when the server is listening but silent", async () => {
    // The budget is 12 s, so this test drives the same path with an
    // abort rather than waiting it out.
    const srv = createServer(() => {
      /* accept, then never answer */
    });
    servers.push(srv);
    await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done));
    const address = srv.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const controller = new AbortController();
    const originalTimeout = AbortSignal.timeout;
    // Force the probe's own timeout to fire immediately.
    AbortSignal.timeout = (() => controller.signal) as typeof AbortSignal.timeout;
    setTimeout(() => controller.abort(), 20);
    try {
      expect(await probeServeHealth({ host: "127.0.0.1", port })).toEqual({
        kind: "unreachable",
      });
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  });
});
