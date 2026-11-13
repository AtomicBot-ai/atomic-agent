import { createHash } from "node:crypto";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import type { OpenAiKeyRotation } from "../provider/openai/openai-http.js";
import { keyRefusalKind, type KeyRefusalKind } from "./link-failure-kind.js";
import {
  freshBreaker,
  registerBreakerFailure,
  type BreakerEntry,
} from "./partition-state.js";
import type { FallbackTiming } from "./fallback-config.js";

/**
 * Several API keys for one provider (ATO-471).
 *
 * A key is one more level inside a link of the fallback chain: when the
 * service refuses a key (a rate limit, a bad or revoked key, an empty
 * account: `keyRefusalKind`) the same request goes out with the next key
 * of the same provider, and only when every key was refused does the
 * error reach the chain, which then moves to the next provider.
 *
 * Order and stickiness: the primary key (`apiKey`) first, then the extra
 * keys in config order, duplicates dropped. The pool stays on the key
 * that last served until that key is refused, so one turn does not hop
 * between keys and a recovered primary does not take over mid-turn; it
 * is tried again when the key in use is refused, or once nothing else
 * is free.
 *
 * Cooldowns use the chain's breaker entry (`partition-state.ts`), one per
 * key, armed immediately on a refusal. A rate limit cools for the
 * provider's `Retry-After` when it sent a longer one. Unlike the chain's
 * breakers this state is process-wide, not per session: a limit belongs
 * to the key, and every session spending the key shares it. It is keyed
 * by provider id and a hash of the key, so the raw key is never a map key
 * and an edited key starts fresh. A restart clears it.
 *
 * Keys never reach a log: the notice names the key by its position
 * ("key 2 of 3").
 */

export interface KeyPoolLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface KeyPoolOptions {
  providerId: string;
  /** Primary key first. Blank entries and duplicates are dropped. */
  keys: readonly string[];
  now?: () => number;
  logger?: KeyPoolLogger;
  /** Test seam: a private store instead of the process-wide one. */
  store?: KeyPoolStore;
}

/** Cooldown ladders per refusal kind; the last entry is the cap. */
export const KEY_COOLDOWN_MS: Readonly<Record<KeyRefusalKind, readonly number[]>> = {
  // Per-minute limits are the common case; a key that keeps hitting it
  // is left alone for longer.
  rate_limit: [60_000, 300_000, 900_000],
  // A refused key or an empty account does not heal by waiting; a
  // config edit (new key = new hash) or a restart retries it sooner.
  auth: [1_800_000],
  billing: [1_800_000],
};

/** No refusal for this long resets a key's ladder. */
const KEY_FAILURE_WINDOW_MS = 3_600_000;

export interface KeyPoolStore {
  readonly keys: Map<string, BreakerEntry>;
  /** Provider id → hash of the key in use. */
  readonly cursor: Map<string, string>;
}

function freshStore(): KeyPoolStore {
  return { keys: new Map(), cursor: new Map() };
}

const sharedStore: KeyPoolStore = freshStore();

/** Test seam: forget every cooldown and cursor. */
export function resetKeyPoolState(): void {
  sharedStore.keys.clear();
  sharedStore.cursor.clear();
}

export function createKeyPoolStore(): KeyPoolStore {
  return freshStore();
}

/** Primary first, trimmed, blanks and duplicates dropped. */
export function orderedUniqueKeys(keys: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const raw of keys) {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (key.length > 0 && !out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * A pool for `keys`, or undefined when there is at most one distinct
 * key: a single-key provider keeps its historical path exactly.
 */
export function createKeyPool(options: KeyPoolOptions): ProviderKeyPool | undefined {
  const keys = orderedUniqueKeys(options.keys);
  return keys.length > 1 ? new ProviderKeyPool({ ...options, keys }) : undefined;
}

export class ProviderKeyPool implements OpenAiKeyRotation {
  private readonly providerId: string;
  private readonly keys: readonly string[];
  private readonly hashes: readonly string[];
  private readonly now: () => number;
  private readonly logger: KeyPoolLogger | undefined;
  private readonly store: KeyPoolStore;

  constructor(options: KeyPoolOptions) {
    this.providerId = options.providerId;
    this.keys = orderedUniqueKeys(options.keys);
    this.hashes = this.keys.map(hashKey);
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
    this.store = options.store ?? sharedStore;
  }

  get size(): number {
    return this.keys.length;
  }

  current(): string {
    const now = this.now();
    const cursor = this.indexOfHash(this.store.cursor.get(this.providerId));
    if (cursor !== -1 && !this.cooling(cursor, now)) return this.keys[cursor]!;
    const free = this.keys.findIndex((_, i) => !this.cooling(i, now));
    if (free !== -1) return this.keys[free]!;
    // Every key is cooling: send with the one free soonest, so the
    // request still goes out and its answer reaches the chain as before.
    return this.keys[this.soonestFree()]!;
  }

  wouldRotate(key: string, err: unknown): boolean {
    if (keyRefusalKind(err) === undefined) return false;
    return this.nextFree(this.keys.indexOf(key), this.now()) !== -1;
  }

  rotate(key: string, err: unknown): string | null {
    const kind = keyRefusalKind(err);
    const index = this.keys.indexOf(key);
    if (kind === undefined || index === -1) return null;
    const now = this.now();
    this.coolDown(index, kind, err, now);
    const next = this.nextFree(index, now);
    if (next === -1) return null;
    this.store.cursor.set(this.providerId, this.hashes[next]!);
    this.logger?.warn(
      `${this.providerId}: key ${index + 1} of ${this.keys.length} refused (${kind}), trying key ${next + 1}`,
      { providerId: this.providerId, refusal: kind, from: index + 1, to: next + 1 },
    );
    return this.keys[next]!;
  }

  succeeded(key: string): void {
    const index = this.keys.indexOf(key);
    if (index === -1) return;
    this.store.keys.delete(this.entryId(index));
    this.store.cursor.set(this.providerId, this.hashes[index]!);
  }

  private coolDown(index: number, kind: KeyRefusalKind, err: unknown, now: number): void {
    const id = this.entryId(index);
    const entry = this.store.keys.get(id) ?? freshBreaker();
    registerBreakerFailure(entry, now, true, timingFor(kind));
    const retryAfter = err instanceof OpenAiHttpError ? err.retryAfterMs : null;
    if (kind === "rate_limit" && retryAfter !== null && retryAfter > 0) {
      entry.cooldownUntil = Math.max(entry.cooldownUntil, now + retryAfter);
    }
    this.store.keys.set(id, entry);
  }

  /** The first key after `from` (wrapping, `from` itself excluded) not cooling. */
  private nextFree(from: number, now: number): number {
    for (let step = 1; step < this.keys.length; step++) {
      const i = (from + step + this.keys.length) % this.keys.length;
      if (i !== from && !this.cooling(i, now)) return i;
    }
    return -1;
  }

  private soonestFree(): number {
    let best = 0;
    for (let i = 1; i < this.keys.length; i++) {
      if (this.cooldownUntil(i) < this.cooldownUntil(best)) best = i;
    }
    return best;
  }

  private cooling(index: number, now: number): boolean {
    return this.cooldownUntil(index) > now;
  }

  private cooldownUntil(index: number): number {
    return this.store.keys.get(this.entryId(index))?.cooldownUntil ?? 0;
  }

  private indexOfHash(hash: string | undefined): number {
    return hash === undefined ? -1 : this.hashes.indexOf(hash);
  }

  private entryId(index: number): string {
    return `${this.providerId}\u0000${this.hashes[index]!}`;
  }
}

function timingFor(kind: KeyRefusalKind): FallbackTiming {
  return {
    failureThreshold: 1,
    cooldownMs: KEY_COOLDOWN_MS[kind],
    probeThrottleMs: 0,
    failureWindowMs: KEY_FAILURE_WINDOW_MS,
  };
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
