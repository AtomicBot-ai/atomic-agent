import type { FailedAttempt } from "./failed-attempts.js";

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
}

export function freshPartition(): PartitionState {
  return {
    breakers: new Map(),
    overrideId: null,
    announcedOverride: false,
    overrideCause: null,
  };
}
