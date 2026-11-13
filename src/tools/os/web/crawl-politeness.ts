/**
 * Polite crawling (ATO-970): a per-host request rate, backoff after 429/503
 * and `Retry-After`, robots.txt with an opt-out for the user's own sites,
 * and a short-lived cache, so `os.web.crawl` neither gets the agent banned
 * nor loads someone else's server.
 *
 * Everything here is in-memory and per process. One `CrawlPoliteness` lives
 * as long as the registered tool, so two crawls in a row share the pace and
 * the cache.
 */
import type { WebCrawlConfig } from "../../../config/index.js";
import {
  ALLOW_ALL,
  DISALLOW_ALL,
  isAllowedByRobots,
  parseRobotsTxt,
  type RobotsPolicy,
} from "./robots-txt.js";

/** A robots.txt `Crawl-delay` above this is capped rather than obeyed literally. */
export const MAX_CRAWL_DELAY_MS = 30_000;
/** Longest pause after a 429/503, whatever `Retry-After` says. */
export const MAX_BACKOFF_MS = 60_000;
/** Pages in a row still throttled after their retries, after which the crawl stops. */
export const THROTTLE_STRIKES_TO_STOP = 3;

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/**
 * Holds one request slot per host at a time: each request waits until the
 * host's next free moment, then pushes it on by the host's delay. Throttle
 * answers push it further. Strikes count pages (not retries) that still got
 * 429/503 after the fetch retries; the crawl resets them when it starts.
 */
export class HostPacer {
  private readonly nextAt = new Map<string, number>();
  private readonly delayMs = new Map<string, number>();
  /** 429/503 answers in a row, retries included: only the backoff length. */
  private readonly backoffStreak = new Map<string, number>();
  /** Pages in a row that ended throttled: what stops a crawl. */
  private readonly strikes = new Map<string, number>();

  constructor(
    private readonly minDelayMs: number,
    private readonly sleep: Sleep,
    private readonly now: () => number = Date.now,
  ) {}

  /** Ask for at least `ms` between requests to `host` (robots.txt `Crawl-delay`). */
  setHostDelay(host: string, ms: number): void {
    this.delayMs.set(host, Math.min(MAX_CRAWL_DELAY_MS, Math.max(this.minDelayMs, ms)));
  }

  hostDelay(host: string): number {
    return this.delayMs.get(host) ?? this.minDelayMs;
  }

  /** Wait for `host`'s turn. The slot is taken before the wait, so concurrent callers queue. */
  async acquire(host: string, signal: AbortSignal): Promise<void> {
    const now = this.now();
    const at = Math.max(now, this.nextAt.get(host) ?? 0);
    this.nextAt.set(host, at + this.hostDelay(host));
    if (at > now) await this.sleep(at - now, signal);
  }

  /**
   * Record one request's answer: 429/503 back off (honouring `Retry-After`),
   * success clears the backoff and the strikes. Called per attempt, so it
   * does not add strikes itself; see `notePageThrottled`.
   */
  noteResponse(host: string, status: number, retryAfterMs: number | null): void {
    if (status === 429 || status === 503) {
      const streak = (this.backoffStreak.get(host) ?? 0) + 1;
      this.backoffStreak.set(host, streak);
      const backoff = retryAfterMs ?? this.hostDelay(host) * 2 ** Math.min(streak, 10);
      const pause = Math.min(MAX_BACKOFF_MS, Math.max(this.hostDelay(host), backoff));
      const at = Math.max(this.nextAt.get(host) ?? 0, this.now() + pause);
      this.nextAt.set(host, at);
      return;
    }
    if (status > 0 && status < 400) {
      this.backoffStreak.delete(host);
      this.strikes.delete(host);
    }
  }

  /** A page still answered 429/503 after its retries: one strike for `host`. */
  notePageThrottled(host: string): void {
    this.strikes.set(host, (this.strikes.get(host) ?? 0) + 1);
  }

  /** Forget `host`'s strikes: each crawl gets its own count (the pace and backoff stay). */
  resetStrikes(host: string): void {
    this.strikes.delete(host);
  }

  /** Have too many pages of `host` in a row ended with "slow down"? */
  isThrottled(host: string): boolean {
    return (this.strikes.get(host) ?? 0) >= THROTTLE_STRIKES_TO_STOP;
  }
}

/** A small TTL + size-bounded map. `ttlMs` of 0 stores nothing. */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.ttlMs <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/** What a robots.txt fetch came back with, as the policy layer needs it. */
export interface RobotsFetchResult {
  status: number;
  body: string;
}

/** Fetches `<origin>/robots.txt`; throws on a network failure. */
export type RobotsFetcher = (robotsUrl: string) => Promise<RobotsFetchResult>;

export interface RobotsDecision {
  policy: RobotsPolicy;
  /** Why the policy is what it is, for the crawl report. */
  source: "exempt" | "disabled" | "file" | "missing" | "unreachable";
}

/** Does `host` match an entry of `web.crawl.robotsExemptHosts`? `*.x.com` covers subdomains and `x.com`. */
export function isExemptHost(host: string, exempt: readonly string[]): boolean {
  const h = host.toLowerCase();
  return exempt.some((entry) => {
    const e = entry.toLowerCase();
    if (e.startsWith("*.")) {
      const base = e.slice(2);
      return h === base || h.endsWith(`.${base}`);
    }
    return h === e;
  });
}

/**
 * Turn a robots.txt answer into a policy (RFC 9309 2.3.1): 2xx is parsed,
 * 4xx means no rules, 5xx / 429 / no answer means stay out.
 */
export function robotsPolicyFromResponse(res: RobotsFetchResult | null): RobotsDecision {
  if (res === null) return { policy: DISALLOW_ALL, source: "unreachable" };
  if (res.status >= 200 && res.status < 300) return { policy: parseRobotsTxt(res.body), source: "file" };
  if (res.status === 429 || res.status >= 500 || res.status === 0) {
    return { policy: DISALLOW_ALL, source: "unreachable" };
  }
  return { policy: ALLOW_ALL, source: "missing" };
}

export interface CrawlPolitenessOptions {
  config: WebCrawlConfig;
  sleep: Sleep;
  now?: () => number;
}

/** Pace, robots.txt and cache, shared by every crawl of one tool instance. */
export class CrawlPoliteness {
  readonly pacer: HostPacer;
  private readonly robots: TtlCache<RobotsDecision>;
  private readonly config: WebCrawlConfig;

  constructor(options: CrawlPolitenessOptions) {
    this.config = options.config;
    this.pacer = new HostPacer(options.config.minDelayMs, options.sleep, options.now);
    // robots.txt is cached at least an hour (RFC 9309 allows up to a day)
    // even when page caching is off: re-reading it per page would double
    // the load the cache exists to spare.
    this.robots = new TtlCache(Math.max(60, options.config.cacheTtlMinutes) * 60_000, 200, options.now);
  }

  /** The robots decision for `url`'s origin, fetched once per origin and cached. */
  async robotsFor(url: URL, fetchRobots: RobotsFetcher): Promise<RobotsDecision> {
    if (isExemptHost(url.hostname, this.config.robotsExemptHosts)) {
      return { policy: ALLOW_ALL, source: "exempt" };
    }
    if (!this.config.respectRobots) return { policy: ALLOW_ALL, source: "disabled" };
    const cached = this.robots.get(url.origin);
    if (cached !== undefined) return cached;
    let res: RobotsFetchResult | null;
    try {
      res = await fetchRobots(`${url.origin}/robots.txt`);
    } catch {
      res = null;
    }
    const decision = robotsPolicyFromResponse(res);
    const delay = decision.policy.crawlDelaySeconds;
    if (delay !== null) this.pacer.setHostDelay(url.host, delay * 1000);
    this.robots.set(url.origin, decision);
    return decision;
  }

  /** Allowed by an already-loaded decision? */
  allows(decision: RobotsDecision, url: URL): boolean {
    return isAllowedByRobots(decision.policy, url);
  }
}
