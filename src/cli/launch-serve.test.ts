import { describe, expect, it } from "vitest";

import { findReusableServe, serveAcceptsKey } from "./launch-serve.js";
import type { ServeRecord } from "./serve-reaper.js";

const record = (over: Partial<ServeRecord> = {}): ServeRecord => ({
  pid: 4242,
  bootPpid: 1,
  daemon: false,
  host: "127.0.0.1",
  port: 41234,
  cwd: "/work",
  startedAt: "2026-11-27T00:00:00Z",
  ...over,
});

function healthFetch(body: Record<string, unknown>): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

describe("launch serve reuse (ATO-2172)", () => {
  it("reuses a live serve in the same folder", async () => {
    const serve = await findReusableServe("/state", "/work", {
      records: () => [record()],
      isAlive: () => true,
      fetch: healthFetch({ runtime: "atomic-agent", pid: 4242, workingDir: "/work" }),
    });
    expect(serve).toEqual({ baseUrl: "http://127.0.0.1:41234", port: 41234, started: false });
  });

  it("skips a serve working in another folder", async () => {
    const serve = await findReusableServe("/state", "/work", {
      records: () => [record()],
      isAlive: () => true,
      fetch: healthFetch({ runtime: "atomic-agent", pid: 4242, workingDir: "/elsewhere" }),
    });
    expect(serve).toBeNull();
  });

  it("skips a record whose port answers with another pid (pid reuse)", async () => {
    const serve = await findReusableServe("/state", "/work", {
      records: () => [record()],
      isAlive: () => true,
      fetch: healthFetch({ runtime: "atomic-agent", pid: 9999, workingDir: "/work" }),
    });
    expect(serve).toBeNull();
  });

  it("skips dead and non-loopback records without probing them", async () => {
    let probed = 0;
    const fetchImpl = (async () => {
      probed++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const serve = await findReusableServe("/state", "/work", {
      records: () => [record({ pid: 1 }), record({ pid: 2, host: "192.168.1.5" })],
      isAlive: (pid) => pid !== 1,
      fetch: fetchImpl,
    });
    expect(serve).toBeNull();
    expect(probed).toBe(0);
  });

  it("never reuses a serve another atag launch started, in any folder or none (ATO-2447)", async () => {
    const deps = {
      records: () => [record({ launched: true })],
      isAlive: () => true,
      fetch: healthFetch({ runtime: "atomic-agent", pid: 4242, workingDir: "/work" }),
    };
    expect(await findReusableServe("/state", null, deps)).toBeNull();
    expect(await findReusableServe("/state", "/work", deps)).toBeNull();
    const own = await findReusableServe("/state", null, { ...deps, records: () => [record({ launched: false })] });
    expect(own?.port).toBe(41234);
  });

  it("serveAcceptsKey is false on 401 and true on 200", async () => {
    const status = (s: number) => (async () => new Response("{}", { status: s })) as unknown as typeof fetch;
    expect(await serveAcceptsKey("http://127.0.0.1:1", "k", status(401))).toBe(false);
    expect(await serveAcceptsKey("http://127.0.0.1:1", "k", status(200))).toBe(true);
  });
});
