import { describe, expect, it, vi } from "vitest";

import { DiscordGateway } from "./discord-gateway.js";
import { backoffMs, type WebSocketLike } from "./discord-gateway-transport.js";
import { OP } from "./discord-channel-types.js";

/** Scriptable fake socket that records every frame the client sends. */
class FakeSocket implements WebSocketLike {
  sent: Array<{ op: number; d: unknown }> = [];
  closed: { code?: number; reason?: string } | null = null;
  private handlers: Record<string, Array<(ev: never) => void>> = {};

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.emit("close", { code: code ?? 1000, reason: reason ?? "" });
  }
  addEventListener(type: string, cb: (ev: never) => void): void {
    (this.handlers[type] ??= []).push(cb);
  }
  emit(type: string, ev: unknown): void {
    for (const cb of this.handlers[type] ?? []) (cb as (e: unknown) => void)(ev);
  }
  /** Feed a gateway frame to the client. */
  frame(op: number, d?: unknown, t?: string, s?: number): void {
    this.emit("message", { data: JSON.stringify({ op, d, t, s }) });
  }
  hello(intervalMs = 60_000): void {
    this.frame(OP.HELLO, { heartbeat_interval: intervalMs });
  }
}

function makeGateway(socket: FakeSocket, over: Record<string, unknown> = {}) {
  const onDispatch = vi.fn();
  const onReady = vi.fn();
  const onClosed = vi.fn();
  const gw = new DiscordGateway({
    token: "tok",
    intents: 4608,
    gatewayUrl: async () => "wss://gw.test",
    logger: { info: vi.fn(), warn: vi.fn() },
    onDispatch,
    onReady,
    onClosed,
    createSocket: () => socket,
    sleep: async () => undefined,
    ...over,
  });
  return { gw, onDispatch, onReady, onClosed };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("DiscordGateway", () => {
  it("identifies with the token and intents after HELLO", async () => {
    const socket = new FakeSocket();
    const { gw } = makeGateway(socket);
    gw.start();
    await tick();
    socket.hello();
    const identify = socket.sent.find((f) => f.op === OP.IDENTIFY);
    expect(identify?.d).toMatchObject({ token: "tok", intents: 4608 });
    await gw.stop();
  });

  it("resumes rather than re-identifying after a droppable disconnect", async () => {
    // Re-identifying every time burns Discord's per-day session-start
    // budget and loses events queued during the gap.
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const { gw } = makeGateway(first, {
      createSocket: () => sockets.shift() ?? new FakeSocket(),
    });
    gw.start();
    await tick();
    first.hello();
    first.frame(OP.DISPATCH, { session_id: "sess-1", resume_gateway_url: "wss://resume.test" }, "READY", 5);
    first.emit("close", { code: 1006, reason: "dropped" });
    await tick();
    await tick();
    second.hello();
    const resume = second.sent.find((f) => f.op === OP.RESUME);
    expect(resume?.d).toMatchObject({ session_id: "sess-1", seq: 5 });
    expect(second.sent.find((f) => f.op === OP.IDENTIFY)).toBeUndefined();
    await gw.stop();
  });

  it("stops and reports on a fatal close instead of retrying forever", async () => {
    const socket = new FakeSocket();
    const { gw, onClosed } = makeGateway(socket);
    gw.start();
    await tick();
    socket.hello();
    socket.emit("close", { code: 4004, reason: "auth failed" });
    await tick();
    expect(onClosed).toHaveBeenCalledWith(
      expect.stringMatching(/bot token/),
      true,
    );
    await gw.stop();
  });

  it("forwards dispatches and signals ready on READY", async () => {
    const socket = new FakeSocket();
    const { gw, onDispatch, onReady } = makeGateway(socket);
    gw.start();
    await tick();
    socket.hello();
    socket.frame(OP.DISPATCH, { session_id: "s" }, "READY", 1);
    socket.frame(OP.DISPATCH, { id: "m1" }, "MESSAGE_CREATE", 2);
    expect(onReady).toHaveBeenCalled();
    expect(onDispatch).toHaveBeenCalledWith("MESSAGE_CREATE", { id: "m1" });
    await gw.stop();
  });

  it("survives a malformed frame", async () => {
    // A JSON parse failure must not take down the connection.
    const socket = new FakeSocket();
    const { gw, onDispatch } = makeGateway(socket);
    gw.start();
    await tick();
    socket.hello();
    socket.emit("message", { data: "{not json" });
    socket.frame(OP.DISPATCH, { id: "m" }, "MESSAGE_CREATE", 1);
    expect(onDispatch).toHaveBeenCalledWith("MESSAGE_CREATE", { id: "m" });
    await gw.stop();
  });

  it("answers an off-cycle heartbeat request", async () => {
    const socket = new FakeSocket();
    const { gw } = makeGateway(socket);
    gw.start();
    await tick();
    socket.hello();
    socket.frame(OP.DISPATCH, {}, "READY", 7);
    socket.frame(OP.HEARTBEAT);
    const beat = socket.sent.filter((f) => f.op === OP.HEARTBEAT).pop();
    expect(beat?.d).toBe(7);
    await gw.stop();
  });

  it("drops the session when INVALID_SESSION says it is not resumable", async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const { gw } = makeGateway(first, {
      createSocket: () => sockets.shift() ?? new FakeSocket(),
    });
    gw.start();
    await tick();
    first.hello();
    first.frame(OP.DISPATCH, { session_id: "sess-1" }, "READY", 1);
    first.frame(OP.INVALID_SESSION, false);
    await tick();
    await tick();
    second.hello();
    expect(second.sent.find((f) => f.op === OP.IDENTIFY)).toBeDefined();
    expect(second.sent.find((f) => f.op === OP.RESUME)).toBeUndefined();
    await gw.stop();
  });

  it("closes cleanly on stop so the session is not left resumable", async () => {
    const socket = new FakeSocket();
    const { gw } = makeGateway(socket);
    gw.start();
    await tick();
    socket.hello();
    await gw.stop();
    expect(socket.closed?.code).toBe(1000);
  });
});

describe("backoffMs", () => {
  it("grows with the attempt and stays capped", () => {
    expect(backoffMs(1, () => 1)).toBeLessThanOrEqual(2500);
    expect(backoffMs(20, () => 1)).toBeLessThanOrEqual(60_500);
  });

  it("always waits at least half a second", () => {
    expect(backoffMs(1, () => 0)).toBeGreaterThanOrEqual(500);
  });

  it("jitters so a fleet does not retry in lockstep", () => {
    expect(backoffMs(5, () => 0)).not.toBe(backoffMs(5, () => 0.99));
  });
});
