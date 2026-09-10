/**
 * Transport seams for `DiscordGateway`: the WebSocket surface it uses,
 * the default factories, and the reconnect backoff.
 *
 * Split out so the gateway file stays inside the 300-line limit and so
 * tests can drive the state machine with a fake socket without touching
 * the global `WebSocket`.
 */

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

/** Backoff ceiling. Discord's session-start budget is per-day, so a
 * flapping network must not be allowed to spin. */
export const MAX_BACKOFF_MS = 60_000;

/**
 * Full-jitter exponential backoff.
 *
 * Full jitter rather than plain exponential because every atomic-agent
 * install pointed at the same bot would otherwise retry in lockstep
 * after a Discord incident and hammer the gateway on recovery.
 */
export function backoffMs(attempt: number, random = Math.random): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 6));
  return Math.floor(random() * ceiling) + 500;
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
