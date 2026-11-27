import type { IncomingMessage } from "node:http";

/**
 * ATO-1126: slow down token guessing on a server reachable from the network.
 *
 * After `maxFailures` wrong or missing bearer tokens from one address within
 * `windowMs`, that address gets `429` for `blockMs` without its token being
 * looked at. A right token still clears the count. Loopback callers (the
 * desktop app, scripts on this machine) are never blocked: they can read the
 * key from the environment anyway, and a typo there must not lock the app out.
 */
export interface AuthThrottleOptions {
  maxFailures?: number;
  windowMs?: number;
  blockMs?: number;
  now?: () => number;
}

export class AuthThrottle {
  private readonly failures = new Map<string, number[]>();
  private readonly blockedUntil = new Map<string, number>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly now: () => number;

  constructor(options: AuthThrottleOptions = {}) {
    this.maxFailures = options.maxFailures ?? 10;
    this.windowMs = options.windowMs ?? 60_000;
    this.blockMs = options.blockMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Seconds this address must wait, or 0 when it may try. */
  retryAfter(address: string | undefined): number {
    if (!address || isLoopbackAddress(address)) return 0;
    const until = this.blockedUntil.get(address);
    if (until === undefined) return 0;
    const left = until - this.now();
    if (left <= 0) {
      this.blockedUntil.delete(address);
      return 0;
    }
    return Math.ceil(left / 1000);
  }

  failed(address: string | undefined): void {
    if (!address || isLoopbackAddress(address)) return;
    const t = this.now();
    this.sweep(t);
    const recent = (this.failures.get(address) ?? []).filter((at) => t - at < this.windowMs);
    recent.push(t);
    if (recent.length >= this.maxFailures) {
      this.failures.delete(address);
      this.blockedUntil.set(address, t + this.blockMs);
      return;
    }
    this.failures.set(address, recent);
  }

  /** Forget windows and blocks that have run out, so addresses that stop calling do not pile up. */
  private sweep(t: number): void {
    if (this.failures.size + this.blockedUntil.size < 1024) return;
    for (const [a, list] of this.failures) if (list.every((at) => t - at >= this.windowMs)) this.failures.delete(a);
    for (const [a, until] of this.blockedUntil) if (until <= t) this.blockedUntil.delete(a);
  }

  succeeded(address: string | undefined): void {
    if (address) this.failures.delete(address);
  }
}

export function isLoopbackAddress(address: string): boolean {
  const a = address.replace(/^::ffff:/i, "");
  return a === "::1" || /^127(?:\.\d{1,3}){3}$/.test(a);
}

/**
 * ATO-2308: the address auth failures are counted against. Usually the
 * socket's own address. `atag pair --remote` puts a cloudflared quick
 * tunnel in front of serve's loopback port, so every caller from the
 * internet arrives from 127.0.0.1 and would never be counted; cloudflared
 * names the real caller in `cf-connecting-ip` (Cloudflare sets it at its
 * edge). That header is trusted only when the socket itself is loopback,
 * where the only other senders are programs on this machine. From any
 * other socket it is ignored, so a remote caller cannot pick its own key.
 */
export function throttleAddress(req: Pick<IncomingMessage, "socket" | "headers">): string | undefined {
  const socketAddress = req.socket?.remoteAddress;
  if (!socketAddress || !isLoopbackAddress(socketAddress)) return socketAddress;
  const raw = req.headers["cf-connecting-ip"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim();
  return value && value.length <= 64 ? value : socketAddress;
}

/**
 * ATO-2308: whether a request really comes from this machine, for routes
 * that give something only to a local caller (`/health` process fields,
 * the saved-keys routes). A loopback socket is not enough: through the
 * `atag pair --remote` cloudflared tunnel every internet caller arrives
 * from 127.0.0.1, and cloudflared marks those requests with
 * `cf-connecting-ip`. Any request carrying that header is treated as
 * remote, whatever its value; a local program that sends it only loses.
 */
export function isLocalRequest(req: Pick<IncomingMessage, "socket" | "headers">): boolean {
  const socketAddress = req.socket?.remoteAddress;
  if (!socketAddress || !isLoopbackAddress(socketAddress)) return false;
  return req.headers["cf-connecting-ip"] === undefined;
}
