import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";

import {
  OfflineNetworkError,
  egressSnapshot,
  isLoopbackHost,
  isOfflineNetwork,
  isOfflineRequestedByEnv,
  offlineNetworkInterceptor,
  offlineRefusal,
  resetOfflineNetworkForTests,
  setOfflineNetwork,
} from "./offline-network.js";
import {
  installTransportDeadlines,
  resetTransportDeadlines,
} from "./transport-deadlines.js";

afterEach(() => {
  resetOfflineNetworkForTests();
});

describe("isLoopbackHost", () => {
  it.each([
    "localhost",
    "LOCALHOST.",
    "127.0.0.1",
    "127.1.2.3",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
  ])("treats %s as this machine", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    "example.com",
    "localhost.example.com",
    "foo.localhost",
    "128.0.0.1",
    "10.0.0.1",
    "0.0.0.0",
    "::",
    "::2",
    "::ffff:8.8.8.8",
    "",
  ])("treats %s as remote", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("offline switch", () => {
  it("is off by default and on from the env", () => {
    expect(isOfflineNetwork({})).toBe(false);
    expect(isOfflineRequestedByEnv({ ATOMIC_AGENT_OFFLINE: "1" })).toBe(true);
    expect(isOfflineRequestedByEnv({ ATOMIC_AGENT_OFFLINE: "off" })).toBe(false);
    expect(isOfflineNetwork({ ATOMIC_AGENT_OFFLINE: "true" })).toBe(true);
  });

  it("refuses remote targets only while on, and counts refusals", () => {
    expect(offlineRefusal("https://example.com/")).toBeNull();
    setOfflineNetwork(true);
    expect(offlineRefusal("http://127.0.0.1:9931/health")).toBeNull();
    expect(offlineRefusal("http://[::1]:8080/")).toBeNull();
    const refused = offlineRefusal("https://api.openai.com/v1/chat");
    expect(refused).toBeInstanceOf(OfflineNetworkError);
    expect(refused?.message).toContain("offline mode: api.openai.com blocked");
    expect(offlineRefusal("not a url")).toBeInstanceOf(OfflineNetworkError);
    expect(egressSnapshot().requestsBlocked).toBe(2);
    setOfflineNetwork(false);
    expect(offlineRefusal("https://api.openai.com/v1/chat")).toBeNull();
  });

  it("resets the counters when offline mode turns on", () => {
    setOfflineNetwork(true);
    offlineRefusal("https://example.com/");
    setOfflineNetwork(false);
    const before = egressSnapshot();
    expect(before.requestsBlocked).toBe(1);
    setOfflineNetwork(true);
    const after = egressSnapshot();
    expect(after.requestsBlocked).toBe(0);
    expect(Date.parse(after.since)).toBeGreaterThanOrEqual(Date.parse(before.since));
  });
});

describe("offlineNetworkInterceptor", () => {
  function run(origin: string, body?: Buffer) {
    const inner = vi.fn<Dispatcher.Dispatch>((_opts, handler) => {
      if (body) handler.onBodySent?.(body);
      return true;
    });
    const dispatch = offlineNetworkInterceptor()(inner as Dispatcher.Dispatch);
    const onResponseError = vi.fn();
    const result = dispatch(
      { origin, path: "/v1/x", method: "POST" },
      { onResponseError },
    );
    return { inner, onResponseError, result };
  }

  it("counts requests and body bytes to remote hosts while online", () => {
    const { inner, onResponseError } = run("https://api.example.com", Buffer.from("hello"));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(onResponseError).not.toHaveBeenCalled();
    const snap = egressSnapshot();
    expect(snap.requestsOut).toBe(1);
    expect(snap.bytesOut).toBe("/v1/x".length + 5);
  });

  it("passes loopback through uncounted", () => {
    const { inner } = run("http://127.0.0.1:9931", Buffer.from("hello"));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(egressSnapshot().requestsOut).toBe(0);
    expect(egressSnapshot().bytesOut).toBe(0);
  });

  it("refuses remote hosts through the handler while offline", () => {
    setOfflineNetwork(true);
    const { inner, onResponseError, result } = run("https://api.example.com");
    expect(inner).not.toHaveBeenCalled();
    expect(result).toBe(false);
    const err = onResponseError.mock.calls[0]?.[1] as Error;
    expect(err).toBeInstanceOf(OfflineNetworkError);
    expect(err.message).toContain("offline mode: api.example.com blocked");
    expect(egressSnapshot()).toMatchObject({ requestsOut: 0, requestsBlocked: 1 });
  });
});

describe("the installed pool in offline mode", () => {
  const original = getGlobalDispatcher();

  afterEach(() => {
    setGlobalDispatcher(original);
    resetTransportDeadlines();
  });

  it("blocks an external host and still reaches 127.0.0.1", async () => {
    const server = http.createServer((_req, res) => res.end("local"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      installTransportDeadlines({ network: { offline: true } } as never);
      expect(isOfflineNetwork()).toBe(true);
      const local = await fetch(`http://127.0.0.1:${port}/`);
      expect(await local.text()).toBe("local");
      // TEST-NET-3: never routed, and the guard refuses before connecting.
      const failure = await fetch("http://203.0.113.7/").then(
        () => null,
        (err: unknown) => err,
      );
      expect(failure).toBeInstanceOf(TypeError);
      const cause = (failure as TypeError & { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(OfflineNetworkError);
      expect(egressSnapshot().requestsOut).toBe(0);
      expect(egressSnapshot().requestsBlocked).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("never sends loopback traffic to an env proxy while offline", async () => {
    // Stands in for a remote proxy: it must see nothing. It answers 502
    // so a regression fails on the assertion instead of hanging.
    const proxyConnections: string[] = [];
    const proxy = net.createServer((socket) => {
      proxyConnections.push(socket.remoteAddress ?? "?");
      socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
    });
    const target = http.createServer((_req, res) => res.end("local"));
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy.address() as AddressInfo).port;
    const targetPort = (target.address() as AddressInfo).port;
    const keys = [
      "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
      "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY",
    ] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    try {
      setOfflineNetwork(true);
      installTransportDeadlines();
      const res = await fetch(`http://127.0.0.1:${targetPort}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("local");
      expect(proxyConnections).toEqual([]);
      expect(egressSnapshot().requestsOut).toBe(0);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
