import { describe, expect, it } from "vitest";

import { AuthThrottle } from "./auth-throttle.js";
import { enforceAuth } from "./request-context.js";

/** ATO-1126: enforceAuth itself, with no socket: the harness binds loopback, which the throttle exempts. */
function call(address: string, token: string, throttle: AuthThrottle, key = "k".repeat(16)) {
  const req = { socket: { remoteAddress: address }, headers: { authorization: `Bearer ${token}` } };
  const out: { status?: number; headers?: Record<string, string>; ok?: boolean } = {};
  const res = {
    statusCode: 200,
    setHeader: () => undefined,
    writeHead(status: number, headers?: Record<string, string>) { out.status = status; out.headers = headers; return this; },
    end: () => undefined,
  };
  out.ok = enforceAuth(req as never, res as never, key, throttle);
  return out;
}

describe("enforceAuth with a throttle (ATO-1126)", () => {
  it("a network address gets 401 ten times, then 429 with retry-after", () => {
    const th = new AuthThrottle({ now: () => 0 });
    for (let i = 0; i < 10; i++) expect(call("10.0.0.9", "nope", th).status).toBe(401);
    const blocked = call("10.0.0.9", "k".repeat(16), th);
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe(429);
    expect(blocked.headers?.["retry-after"]).toBe("60");
  });

  it("loopback is never throttled, and the right key passes", () => {
    const th = new AuthThrottle({ now: () => 0 });
    for (let i = 0; i < 20; i++) expect(call("127.0.0.1", "nope", th).status).toBe(401);
    expect(call("127.0.0.1", "k".repeat(16), th).ok).toBe(true);
  });
});
