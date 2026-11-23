import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  JsonRpcConnection,
  JsonRpcError,
} from "./acp-jsonrpc.js";

function harness(
  onRequest: (method: string, params: unknown) => unknown = () => ({}),
  onNotification?: (method: string, params: unknown) => void,
) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  const frames: Array<Record<string, unknown>> = [];
  let buffer = "";
  const waiters: Array<() => void> = [];
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let i = buffer.indexOf("\n");
    while (i !== -1) {
      frames.push(JSON.parse(buffer.slice(0, i)) as Record<string, unknown>);
      buffer = buffer.slice(i + 1);
      i = buffer.indexOf("\n");
    }
    for (const w of waiters.splice(0)) w();
  });
  const connection = new JsonRpcConnection({
    input,
    output,
    onRequest,
    ...(onNotification ? { onNotification } : {}),
  });
  const next = async (count: number): Promise<Array<Record<string, unknown>>> => {
    while (frames.length < count) await new Promise<void>((r) => waiters.push(r));
    return frames;
  };
  const send = (value: unknown): void => {
    input.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
  };
  return { input, output, frames, connection, next, send };
}

describe("JsonRpcConnection (ATO-543)", () => {
  it("answers a request with its result on one line", async () => {
    const h = harness((method, params) => ({ method, params }));
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    const [frame] = await h.next(1);
    expect(frame).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { method: "initialize", params: { protocolVersion: 1 } },
    });
  });

  it("reassembles a message split across chunks and handles two in one chunk", async () => {
    const h = harness((method) => method);
    const a = JSON.stringify({ jsonrpc: "2.0", id: "a", method: "one" });
    const b = JSON.stringify({ jsonrpc: "2.0", id: "b", method: "two" });
    h.input.write(a.slice(0, 10));
    h.input.write(`${a.slice(10)}\n${b}\n`);
    const frames = await h.next(2);
    expect(frames.map((f) => f.result)).toEqual(["one", "two"]);
  });

  it("maps a JsonRpcError to its code and any other throw to -32603", async () => {
    const h = harness((method) => {
      if (method === "nope") throw new JsonRpcError(JSONRPC_METHOD_NOT_FOUND, "method not found: nope");
      throw new Error("boom");
    });
    h.send({ jsonrpc: "2.0", id: 1, method: "nope" });
    h.send({ jsonrpc: "2.0", id: 2, method: "crash" });
    const frames = await h.next(2);
    const byId = new Map(frames.map((f) => [f.id, f.error as { code: number; message: string }]));
    expect(byId.get(1)).toEqual({ code: JSONRPC_METHOD_NOT_FOUND, message: "method not found: nope" });
    expect(byId.get(2)).toEqual({ code: -32603, message: "boom" });
  });

  it("answers a line that is not JSON with a parse error and id null", async () => {
    const h = harness();
    h.send("{not json");
    const [frame] = await h.next(1);
    expect(frame!.id).toBeNull();
    expect((frame!.error as { code: number }).code).toBe(JSONRPC_PARSE_ERROR);
  });

  it("rejects a message without jsonrpc 2.0", async () => {
    const h = harness();
    h.send({ id: 3, method: "initialize" });
    const [frame] = await h.next(1);
    expect(frame!.id).toBe(3);
    expect((frame!.error as { code: number }).code).toBe(JSONRPC_INVALID_REQUEST);
  });

  it("passes notifications to the handler and never answers them", async () => {
    const seen: Array<[string, unknown]> = [];
    const h = harness(() => "ok", (method, params) => seen.push([method, params]));
    h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } });
    h.send({ jsonrpc: "2.0", id: 9, method: "ping" });
    const frames = await h.next(1);
    expect(seen).toEqual([["session/cancel", { sessionId: "s1" }]]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.id).toBe(9);
  });

  it("sends its own requests and resolves them from the peer's response", async () => {
    const h = harness();
    const pending = h.connection.request("session/request_permission", { sessionId: "s1" });
    const [out] = await h.next(1);
    expect(out).toMatchObject({ jsonrpc: "2.0", method: "session/request_permission", params: { sessionId: "s1" } });
    h.send({ jsonrpc: "2.0", id: out!.id, result: { outcome: { outcome: "selected", optionId: "allow" } } });
    await expect(pending).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("rejects its own request with the peer's error", async () => {
    const h = harness();
    const pending = h.connection.request("x", {});
    const [out] = await h.next(1);
    h.send({ jsonrpc: "2.0", id: out!.id, error: { code: -32000, message: "denied" } });
    await expect(pending).rejects.toMatchObject({ code: -32000, message: "denied" });
  });

  it("fails pending requests and resolves closed when input ends", async () => {
    const h = harness();
    const pending = h.connection.request("x", {});
    await h.next(1);
    h.input.end();
    await expect(pending).rejects.toThrow(/connection closed/);
    await expect(h.connection.closed).resolves.toBeUndefined();
  });

  it("writes notifications without an id", async () => {
    const h = harness();
    h.connection.notify("session/update", { sessionId: "s1" });
    const [frame] = await h.next(1);
    expect(frame).toEqual({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1" } });
  });
});
