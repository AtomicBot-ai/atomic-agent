import { describe, expect, it, vi } from "vitest";

import type { WebSocketLike } from "../discord/discord-gateway-transport.js";
import { SlackApiError } from "./slack-api.js";
import { SlackSocket } from "./slack-socket.js";
import type { SlackEnvelope } from "./slack-types.js";

class FakeSocket {
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Array<(ev: never) => void>> = {};
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", { code, reason: "" });
  }
  addEventListener(type: string, cb: (ev: never) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  emit(type: string, ev: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev as never);
  }
  frame(obj: unknown): void {
    this.emit("message", { data: JSON.stringify(obj) });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeSocket(over: Partial<ConstructorParameters<typeof SlackSocket>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const envelopes: SlackEnvelope[] = [];
  const onReady = vi.fn();
  const onClosed = vi.fn();
  const onReconnecting = vi.fn();
  const openUrl = vi.fn(async () => "wss://slack.invalid/link?ticket=t");
  const socket = new SlackSocket({
    openUrl,
    logger: { info: vi.fn(), warn: vi.fn() },
    onEnvelope: (e) => envelopes.push(e),
    onReady,
    onClosed,
    onReconnecting,
    // Zero jitter: backoffMs floors at 500 ms; tests stop before it fires.
    random: () => 0,
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as WebSocketLike;
    },
    ...over,
  });
  return { socket, sockets, envelopes, onReady, onClosed, onReconnecting, openUrl };
}

describe("SlackSocket", () => {
  it("acks every envelope before handing it on", async () => {
    const { socket, sockets, envelopes } = makeSocket();
    socket.start();
    await flush();
    sockets[0]!.frame({ type: "events_api", envelope_id: "e1", payload: { event: { type: "app_mention" } } });
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ envelope_id: "e1" });
    expect(envelopes).toHaveLength(1);
    await socket.stop();
  });

  it("reports ready on hello", async () => {
    const { socket, sockets, onReady } = makeSocket();
    socket.start();
    await flush();
    sockets[0]!.frame({ type: "hello", num_connections: 1 });
    expect(onReady).toHaveBeenCalledTimes(1);
    await socket.stop();
  });

  it("reconnects with a fresh URL after disconnect", async () => {
    vi.useFakeTimers();
    try {
      const { socket, sockets, openUrl, onReconnecting, onClosed } = makeSocket();
      socket.start();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.frame({ type: "disconnect", reason: "refresh_requested" });
      expect(sockets[0]!.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(onReconnecting).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(600);
      expect(openUrl).toHaveBeenCalledTimes(2);
      expect(sockets).toHaveLength(2);
      expect(onClosed).not.toHaveBeenCalled();
      await socket.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops for good when Socket Mode is disabled for the app", async () => {
    const { socket, sockets, onClosed, openUrl } = makeSocket();
    socket.start();
    await flush();
    sockets[0]!.frame({ type: "disconnect", reason: "link_disabled" });
    await flush();
    expect(onClosed).toHaveBeenCalledWith(expect.stringMatching(/Socket Mode is disabled/), true);
    expect(openUrl).toHaveBeenCalledTimes(1);
    await socket.stop();
  });

  it("stops for good on a rejected app token", async () => {
    const { socket, onClosed } = makeSocket({
      openUrl: async () => {
        throw new SlackApiError("invalid_auth");
      },
    });
    socket.start();
    await flush();
    expect(onClosed).toHaveBeenCalledWith(expect.stringMatching(/rejected the token/), true);
    await socket.stop();
  });

  it("stop() during the backoff wait returns without waiting it out", async () => {
    const { socket } = makeSocket({
      openUrl: async () => {
        throw new Error("network down");
      },
      random: () => 0.99,
    });
    socket.start();
    await flush();
    const started = Date.now();
    await socket.stop();
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("survives a frame that is not JSON", async () => {
    const { socket, sockets, envelopes } = makeSocket();
    socket.start();
    await flush();
    sockets[0]!.emit("message", { data: "not json" });
    sockets[0]!.frame({ type: "interactive", envelope_id: "e2", payload: {} });
    expect(envelopes).toHaveLength(1);
    await socket.stop();
  });
});
