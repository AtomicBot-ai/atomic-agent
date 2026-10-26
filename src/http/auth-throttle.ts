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
    const recent = (this.failures.get(address) ?? []).filter((at) => t - at < this.windowMs);
    recent.push(t);
    if (recent.length >= this.maxFailures) {
      this.failures.delete(address);
      this.blockedUntil.set(address, t + this.blockMs);
      return;
    }
    this.failures.set(address, recent);
  }

  succeeded(address: string | undefined): void {
    if (address) this.failures.delete(address);
  }
}

export function isLoopbackAddress(address: string): boolean {
  const a = address.replace(/^::ffff:/i, "");
  return a === "::1" || /^127(?:\.\d{1,3}){3}$/.test(a);
}
