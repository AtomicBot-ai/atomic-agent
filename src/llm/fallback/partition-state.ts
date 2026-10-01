import type { FailedAttempt } from "./failed-attempts.js";
import type { FallbackTiming } from "./fallback-config.js";
import { isOutageFailure } from "./link-failure-kind.js";

/**
 * A single provider's circuit-breaker state. All timestamps are epoch
 * milliseconds read from the injected `now()` clock, never a timer.
 */
export interface BreakerEntry {
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

export function freshBreaker(): BreakerEntry {
  return {
    consecutiveFailures: 0,
    cooldownUntil: 0,
    cooldownStep: 0,
    lastFailureAt: 0,
    lastProbeAt: 0,
  };
}

/**
 * All mutable breaker state for ONE partition (see the class doc on
 * `ProviderFallbackChain` for why the chain partitions by session). A
 * partition owns its own per-provider breakers plus the sticky-override
 * bookkeeping, so one session's health accounting never leaks into
 * another's.
 */
export interface PartitionState {
  /** Per-provider circuit-breaker entries for this partition. */
  readonly breakers: Map<string, BreakerEntry>;
  /** Sticky working provider after a switch-away; null = on primary. */
  overrideId: string | null;
  /** Whether the current override was already announced (dedupe). */
  announcedOverride: boolean;
  /**
   * The primary's latest failure while the override stands — the one that
   * switched away, refreshed by each failed probe. Null on the primary.
   */
  overrideCause: FailedAttempt | null;
  /**
   * Whether the link `overrideId` points at has answered since the
   * pointer last moved. False while it only stood in: the chain advanced
   * onto it and it has not served anything yet, or it failed too.
   */
  overrideServed: boolean;
  /**
   * Whether any fallback link has answered since the chain switched away
   * from the primary. Unlike `overrideServed` it survives the pointer
   * moving on: a fallback that served and then went down for a moment is
   * still the route this partition is running on.
   */
  fallbackServed: boolean;
}

export function freshPartition(): PartitionState {
  return {
    breakers: new Map(),
    overrideId: null,
    announcedOverride: false,
    overrideCause: null,
    overrideServed: false,
    fallbackServed: false,
  };
}

/**
 * Is `p` on a stand-in: an override set by a primary that said no (a bad
 * or missing key, an unknown model: anything `isOutageFailure` does not
 * call an outage), on a link that has not served a call since it took
 * over? `pickProvider` routes the next call back to the primary then,
 * whatever the cooldown and the probe throttle say: both exist to keep
 * turns off a primary that is down, and this one is up. What it objected
 * to is fixed by the user, who may well be fixing it while the turn
 * waits. The stand-in has proven nothing; staying on it is how a parked
 * turn spent five minutes retrying a stopped local server and never
 * asked the primary again (item 29). Once it serves a call it is a
 * working fallback, and the usual stickiness applies.
 */
export function isStandIn(p: PartitionState): boolean {
  return (
    p.overrideId !== null &&
    !p.overrideServed &&
    p.overrideCause !== null &&
    !isOutageFailure(p.overrideCause.error)
  );
}

/**
 * Count one advance-worthy failure on breaker `b` at `now`, and arm (or
 * escalate) its cooldown once the breaker trips: either an immediate
 * signal, or the consecutive-failure threshold is reached.
 */
export function registerBreakerFailure(
  b: BreakerEntry,
  now: number,
  immediate: boolean,
  timing: FallbackTiming,
): void {
  // Reset the streak if the last failure is older than the no-error
  // window — the provider had a clean run since, so start fresh.
  if (b.lastFailureAt > 0 && now - b.lastFailureAt >= timing.failureWindowMs) {
    b.consecutiveFailures = 0;
    b.cooldownStep = 0;
  }
  b.consecutiveFailures += 1;
  b.lastFailureAt = now;
  if (immediate || b.consecutiveFailures >= timing.failureThreshold) {
    const step = Math.min(b.cooldownStep, timing.cooldownMs.length - 1);
    b.cooldownUntil = now + timing.cooldownMs[step]!;
    b.cooldownStep = Math.min(b.cooldownStep + 1, timing.cooldownMs.length - 1);
  }
}

/** Back on the primary: no override, nothing announced, nothing served. */
export function clearOverride(p: PartitionState): void {
  p.overrideId = null;
  p.announcedOverride = false;
  p.overrideCause = null;
  p.overrideServed = false;
  p.fallbackServed = false;
}
