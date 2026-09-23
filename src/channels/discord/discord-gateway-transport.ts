/**
 * Transport seams for `DiscordGateway`: the WebSocket surface it uses,
 * the default factories, and the reconnect backoff.
 *
 * Split out so the gateway file stays inside the 300-line limit and so
 * tests can drive the state machine with a fake socket without touching
 * the global `WebSocket`.
 */

/**
 * The backoff lives in `../reconnect-backoff.ts`, shared with the
 * Telegram poller. Re-exported so the gateway, its tests and the
 * package index keep importing it from here unchanged.
 */
export { MAX_BACKOFF_MS, backoffMs } from "../reconnect-backoff.js";

/** The slice of the WebSocket API the gateway client uses. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", cb: () => void): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    cb: (ev: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
}

export function defaultSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
