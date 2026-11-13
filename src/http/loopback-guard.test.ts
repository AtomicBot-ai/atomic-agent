import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { checkLoopbackRequest, isLoopbackHostname } from "./loopback-guard.js";
import { startTestHarness, type Harness } from "./test-harness.js";

interface Sent {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** node:http, not fetch: fetch will not let a test set `Host`. */
function send(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Sent> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, method, path: url.pathname, headers: body === undefined ? headers : { ...headers, "content-length": String(Buffer.byteLength(body)) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const JSON_HEADERS = { "content-type": "application/json" };
/** An approval id nobody holds: past the guard the route answers 404, never 403/415. */
const RESOLVE_BODY = JSON.stringify({ approvalId: "missing", decision: "deny" });

function fakeReq(method: string, headers: Record<string, string>) {
  return { method, headers } as never;
}

describe("checkLoopbackRequest (ATO-1495)", () => {
  const opts = { env: {}, machineHostname: "nadyas-mac.local" };

  it("accepts loopback hosts with or without a port", () => {
    for (const host of ["localhost:8787", "127.0.0.1:8787", "127.4.5.6", "[::1]:8787", "app.localhost:8787", "nadyas-mac.local:8787", "nadyas-mac"]) {
      expect(checkLoopbackRequest(fakeReq("GET", { host }), opts), host).toBeNull();
    }
  });

  it("refuses a rebinding Host", () => {
    for (const host of ["evil.example:8787", "evil.example", "192.168.1.5:8787", "localhost.evil.example", "127.0.0.1.evil.example"]) {
      expect(checkLoopbackRequest(fakeReq("GET", { host }), opts)?.code, host).toBe("host_not_allowed");
    }
  });

  it("refuses foreign and opaque origins, honours the allow-list", () => {
    const host = "127.0.0.1:8787";
    expect(checkLoopbackRequest(fakeReq("GET", { host, origin: "https://evil.example" }), opts)?.code).toBe("origin_not_allowed");
    expect(checkLoopbackRequest(fakeReq("GET", { host, origin: "null" }), opts)?.code).toBe("origin_not_allowed");
    expect(checkLoopbackRequest(fakeReq("GET", { host, origin: "http://localhost:3000" }), opts)).toBeNull();
    const env = { ATOMIC_AGENT_ALLOWED_ORIGINS: "https://app.example, chrome-extension://*" };
    expect(checkLoopbackRequest(fakeReq("GET", { host, origin: "https://app.example" }), { ...opts, env })).toBeNull();
    expect(checkLoopbackRequest(fakeReq("GET", { host, origin: "chrome-extension://abc" }), { ...opts, env })).toBeNull();
    expect(checkLoopbackRequest(fakeReq("GET", { host, origin: "https://other.example" }), { ...opts, env })?.code).toBe("origin_not_allowed");
  });

  it("wants JSON for a body, lets a bodyless POST through", () => {
    const host = "127.0.0.1:8787";
    expect(checkLoopbackRequest(fakeReq("POST", { host, "content-length": "5", "content-type": "text/plain" }), opts)?.status).toBe(415);
    expect(checkLoopbackRequest(fakeReq("PATCH", { host, "transfer-encoding": "chunked" }), opts)?.status).toBe(415);
    expect(checkLoopbackRequest(fakeReq("POST", { host, "content-length": "5", "content-type": "application/json; charset=utf-8" }), opts)).toBeNull();
    expect(checkLoopbackRequest(fakeReq("POST", { host }), opts)).toBeNull();
    expect(checkLoopbackRequest(fakeReq("POST", { host, "content-length": "0" }), opts)).toBeNull();
  });

  it("isLoopbackHostname covers the mapped IPv6 form", () => {
    expect(isLoopbackHostname("[::ffff:7f00:1]", "x")).toBe(true);
    expect(isLoopbackHostname("[::2]", "x")).toBe(false);
  });
});

describe("serve without an API key (ATO-1495)", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
  });

  it("refuses foreign Origin, rebinding Host, text/plain and foreign preflights; lets loopback and CLI clients in", async () => {
    harness = await startTestHarness();
    const { baseUrl } = harness;
    const host = new URL(baseUrl).host;

    const foreign = await send(baseUrl, "POST", "/api/approval/resolve", { host, origin: "https://evil.example", ...JSON_HEADERS }, RESOLVE_BODY);
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body).error.code).toBe("origin_not_allowed");
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();

    const rebound = await send(baseUrl, "PATCH", "/api/config", { host: `evil.example:${new URL(baseUrl).port}`, ...JSON_HEADERS }, "{}");
    expect(rebound.status).toBe(403);
    expect(JSON.parse(rebound.body).error.code).toBe("host_not_allowed");

    const plain = await send(baseUrl, "POST", "/api/approval/resolve", { host, "content-type": "text/plain" }, RESOLVE_BODY);
    expect(plain.status).toBe(415);

    const preflight = await send(baseUrl, "OPTIONS", "/api/config", { host, origin: "https://evil.example", "access-control-request-method": "PATCH" });
    expect(preflight.status).toBe(403);
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();

    const loopbackPage = await send(baseUrl, "POST", "/api/approval/resolve", { host, origin: "http://localhost:3000", ...JSON_HEADERS }, RESOLVE_BODY);
    expect([403, 415]).not.toContain(loopbackPage.status);

    const cli = await send(baseUrl, "POST", "/api/approval/resolve", { host, ...JSON_HEADERS }, RESOLVE_BODY);
    expect([403, 415]).not.toContain(cli.status);

    const health = await send(baseUrl, "GET", "/health", { host });
    expect(health.status).not.toBe(403);
  });

  it("with an API key the guard is off and the key decides", async () => {
    harness = await startTestHarness({ apiKey: "k".repeat(24) });
    const { baseUrl } = harness;
    const port = new URL(baseUrl).port;
    const auth = { authorization: `Bearer ${"k".repeat(24)}` };

    const keyed = await send(baseUrl, "POST", "/api/approval/resolve", { host: `evil.example:${port}`, origin: "https://evil.example", "content-type": "text/plain", ...auth }, RESOLVE_BODY);
    expect([403, 415]).not.toContain(keyed.status);

    const noKey = await send(baseUrl, "POST", "/api/approval/resolve", { host: `evil.example:${port}`, ...JSON_HEADERS }, RESOLVE_BODY);
    expect(noKey.status).toBe(401);
  });
});
