import { describe, expect, it, vi } from "vitest";

import { SignalRpc, SignalRpcError } from "./signal-rpc.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("SignalRpc", () => {
  it("posts a JSON-RPC send to /api/v1/rpc with the recipient as an array", async () => {
    const fetch = vi.fn(async () => json({ jsonrpc: "2.0", result: { timestamp: 999 }, id: 1 }));
    const rpc = new SignalRpc({ url: "http://127.0.0.1:8080", fetch });
    await expect(rpc.send({ recipient: "+15550002222" }, "hello")).resolves.toBe(999);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/api/v1/rpc");
    expect(JSON.parse(String(init.body))).toEqual({
      jsonrpc: "2.0",
      method: "send",
      params: { recipient: ["+15550002222"], message: "hello" },
      id: 1,
    });
  });

  it("sends to a group by groupId and supports stopping typing", async () => {
    const fetch = vi.fn(async () => json({ jsonrpc: "2.0", result: {}, id: 1 }));
    const rpc = new SignalRpc({ url: "http://x", fetch });
    await rpc.sendTyping({ groupId: "R3JvdXA=" }, true);
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.method).toBe("sendTyping");
    expect(body.params).toEqual({ groupId: "R3JvdXA=", stop: true });
  });

  it("turns a JSON-RPC error into SignalRpcError", async () => {
    const fetch = vi.fn(async () => json({ jsonrpc: "2.0", error: { code: -1, message: "Unregistered user" }, id: 1 }));
    const rpc = new SignalRpc({ url: "http://x", fetch });
    await expect(rpc.send({ recipient: "+1" }, "x")).rejects.toThrow(/Unregistered user/);
  });

  it("names the daemon url when the connection is refused", async () => {
    const fetch = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const rpc = new SignalRpc({ url: "http://127.0.0.1:8080", fetch });
    const err = await rpc.send({ recipient: "+1" }, "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignalRpcError);
    expect((err as Error).message).toBe(
      "signal-cli daemon not reachable at http://127.0.0.1:8080 (ECONNREFUSED)",
    );
  });
});
