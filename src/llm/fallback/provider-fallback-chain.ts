import type { ResolvedFallbackChain } from "./fallback-config.js";
import { shouldAdvance } from "./should-advance.js";

/**
 * A single provider's circuit-breaker state. All timestamps are epoch
 * milliseconds read from the injected `now()` clock, never a timer.
 */
interface BreakerEntry {
  /** Consecutive advance-worthy failures; drives the threshold + cooldown ladder. */
  consecutiveFailures: number;
  /** Provider is in cooldown until this instant (0 = healthy). */
  cooldownUntil: number;
  /** Index into the cooldown ladder for the next escalation. */
  cooldownStep: number;
  /** When the last advance-worthy failure landed (for the reset window). */
  lastFailureAt: number;
  /** When the primary was last probed (probe throttle). */
  lastProbeAt: number;
}

function freshBreaker(): BreakerEntry {
  return {
    consecutiveFailures: 0,
    cooldownUntil: 0,
    cooldownStep: 0,
    lastFailureAt: 0,
    lastProbeAt: 0,
  };
}

/** Emitted once per state transition; wired to an `AgentLoopEvent` by bootstrap. */
export interface ProviderSwitchNotice {
  direction: "away" | "back";
  from: string;
  to: string;
  reason: string;
}

/** What `pickProvider` decided for the turn about to run. */
export interface ProviderPick {
  /** Provider id to route this turn through. */
  providerId: string;
  /** True when this turn is a throttled probe of the primary. */
  isProbe: boolean;
}

export interface FallbackChainOptions {
  /** Live resolver — re-read each turn so config hot-swaps take effect. */
  resolve: () => ResolvedFallbackChain;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /** One-shot state-change notices (switch away / switch back). */
  noticeSink?: (notice: ProviderSwitchNotice) => void;
}

/**
 * Cross-provider circuit breaker layered over the single-provider
 * reliability slice. Owns no timer: every decision is computed lazily
 * from the wall clock at the moment a turn asks for a provider (see
 * AGENTS.md §"Provider fallback chain" — lazy probe carve-out).
 *
 * The wrapper that drives real completions calls, per turn:
 *   1. `pickProvider()` once, to choose the starting provider;
 *   2. on a failure, `advanceFrom(id, err)` to get the next link (or null
 *      when the chain is exhausted or the error is not fallover-worthy);
 *   3. `recordSuccess(id, wasProbe)` when a provider answers.
 */
export class ProviderFallbackChain {
  private readonly resolve: () => ResolvedFallbackChain;
  private readonly now: () => number;
  private readonly noticeSink?: (notice: ProviderSwitchNotice) => void;
  private readonly breakers = new Map<string, BreakerEntry>();

  /** Sticky working provider after a switch-away; null = on primary. */
  private overrideId: string | null = null;
  /** Whether the current override was already announced (dedupe). */
  private announcedOverride = false;

  constructor(options: FallbackChainOptions) {
    this.resolve = options.resolve;
    this.now = options.now ?? Date.now;
    if (options.noticeSink) this.noticeSink = options.noticeSink;
  }

  /**
   * Choose the provider for the turn about to start. Resolves the live
   * chain, drops a stale override that no longer names a chain member,
   * and — when the primary's cooldown has elapsed and the probe throttle
   * allows — routes this one turn back to the primary as a probe.
   */
  pickProvider(): ProviderPick {
    const { chain } = this.resolve();
    const primary = chain[0];
    if (!primary) {
      // Degenerate: no configured chain. Caller will surface its own
      // "no provider" error; return a harmless sentinel.
      return { providerId: "", isProbe: false };
    }

    // A user hot-swap (new primary) or a chain edit that dropped the
    // override provider drops the override entirely.
    if (this.overrideId && !chain.includes(this.overrideId)) {
      this.clearOverride();
    }

    if (!this.overrideId) {
      return { providerId: primary, isProbe: false };
    }

    // On an override: consider probing the primary.
    const now = this.now();
    const b = this.breaker(primary);
    const cooledDown = now >= b.cooldownUntil;
    const throttleOk = now - b.lastProbeAt >= this.resolve().timing.probeThrottleMs;
    if (cooledDown && throttleOk) {
      b.lastProbeAt = now;
      return { providerId: primary, isProbe: true };
    }
    return { providerId: this.overrideId, isProbe: false };
  }

  /**
   * A failure hit `fromId`. Update its breaker and return the next
   * provider to try this turn, or null when there is nothing left to try
   * (chain exhausted) or the error is not fallover-worthy.
   */
  advanceFrom(fromId: string, err: unknown): string | null {
    const decision = shouldAdvance(err);
    if (!decision.advance) return null;

    const { chain, timing } = this.resolve();
    this.registerFailure(fromId, decision.immediate, timing);

    const idx = chain.indexOf(fromId);
    // Next healthy link after `fromId`. When `fromId` is not in the chain
    // (raced config edit) start from the top.
    const startFrom = idx < 0 ? 0 : idx + 1;
    for (let i = startFrom; i < chain.length; i += 1) {
      const candidate = chain[i]!;
      if (candidate === fromId) continue;
      this.switchAwayTo(chain[0]!, fromId, candidate, err);
      return candidate;
    }
    return null;
  }

  /** A provider answered. Clear its breaker; fold a successful probe back to primary. */
  recordSuccess(id: string, wasProbe: boolean): void {
    const b = this.breaker(id);
    b.consecutiveFailures = 0;
    b.cooldownUntil = 0;
    b.cooldownStep = 0;
    b.lastFailureAt = 0;

    const { chain } = this.resolve();
    const primary = chain[0];
    if (wasProbe && id === primary && this.overrideId) {
      const from = this.overrideId;
      this.clearOverride();
      this.emit({
        direction: "back",
        from,
        to: id,
        reason: "primary recovered",
      });
    }
  }

  /** Test/inspection hook: is a sticky override currently active? */
  get activeOverride(): string | null {
    return this.overrideId;
  }

  private registerFailure(
    id: string,
    immediate: boolean,
    timing: ResolvedFallbackChain["timing"],
  ): void {
    const now = this.now();
    const b = this.breaker(id);

    // Reset the streak if the last failure is older than the no-error
    // window — the provider had a clean run since, so start fresh.
    if (b.lastFailureAt > 0 && now - b.lastFailureAt >= timing.failureWindowMs) {
      b.consecutiveFailures = 0;
      b.cooldownStep = 0;
    }
    b.consecutiveFailures += 1;
    b.lastFailureAt = now;

    // Arm (or escalate) the cooldown once the breaker trips: either an
    // immediate signal, or the consecutive-failure threshold is reached.
    const tripped = immediate || b.consecutiveFailures >= timing.failureThreshold;
    if (tripped) {
      const step = Math.min(b.cooldownStep, timing.cooldownMs.length - 1);
      b.cooldownUntil = now + timing.cooldownMs[step]!;
      b.cooldownStep = Math.min(b.cooldownStep + 1, timing.cooldownMs.length - 1);
    }
  }

  private switchAwayTo(
    primary: string,
    fromId: string,
    toId: string,
    err: unknown,
  ): void {
    // Only the first hop off the primary flips the sticky override and
    // announces; deeper hops within the same turn stay silent.
    if (fromId === primary && !this.overrideId) {
      this.overrideId = toId;
      this.announcedOverride = false;
    } else if (this.overrideId) {
      // Chain continued past a dead deeper link — keep the override
      // pointed at the newest working candidate.
      this.overrideId = toId;
    }
    if (!this.announcedOverride) {
      this.announcedOverride = true;
      this.emit({
        direction: "away",
        from: fromId,
        to: toId,
        reason: describeReason(err),
      });
    }
  }

  private clearOverride(): void {
    this.overrideId = null;
    this.announcedOverride = false;
  }

  private breaker(id: string): BreakerEntry {
    let b = this.breakers.get(id);
    if (!b) {
      b = freshBreaker();
      this.breakers.set(id, b);
    }
    return b;
  }

  private emit(notice: ProviderSwitchNotice): void {
    this.noticeSink?.(notice);
  }
}

function describeReason(err: unknown): string {
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "provider unavailable";
}
