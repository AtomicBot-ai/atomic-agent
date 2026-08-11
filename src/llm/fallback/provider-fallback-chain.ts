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
 * All mutable breaker state for ONE partition (see the class doc on why
 * the chain partitions by session). A partition owns its own per-provider
 * breakers plus the sticky-override bookkeeping, so one session's health
 * accounting never leaks into another's.
 */
interface PartitionState {
  /** Per-provider circuit-breaker entries for this partition. */
  readonly breakers: Map<string, BreakerEntry>;
  /** Sticky working provider after a switch-away; null = on primary. */
  overrideId: string | null;
  /** Whether the current override was already announced (dedupe). */
  announcedOverride: boolean;
}

function freshPartition(): PartitionState {
  return { breakers: new Map(), overrideId: null, announcedOverride: false };
}

/**
 * The default partition key. Callers that do not pass one (most tests,
 * and any non-session-scoped caller) share this single partition — the
 * pre-partitioning behaviour, preserved verbatim.
 */
const DEFAULT_PARTITION = "";

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

  /**
   * Breaker state partitioned by key (session id). One shared chain
   * instance serves the main loop and every sub-runner across all
   * concurrent sessions; without partitioning, one session's success
   * would reset a cooldown another session just armed, and their failure
   * counters would cross-contaminate. Each partition is fully isolated.
   */
  private readonly partitions = new Map<string, PartitionState>();

  constructor(options: FallbackChainOptions) {
    this.resolve = options.resolve;
    this.now = options.now ?? Date.now;
    if (options.noticeSink) this.noticeSink = options.noticeSink;
  }

  /**
   * Choose the provider for the turn about to start, for partition
   * `partitionKey` (default = the shared partition). Resolves the live
   * chain, drops a stale override that no longer names a chain member,
   * and — when the primary's cooldown has elapsed and the probe throttle
   * allows — routes this one turn back to the primary as a probe.
   */
  pickProvider(partitionKey: string = DEFAULT_PARTITION): ProviderPick {
    const { chain } = this.resolve();
    const primary = chain[0];
    if (!primary) {
      // Degenerate: no configured chain. Caller will surface its own
      // "no provider" error; return a harmless sentinel.
      return { providerId: "", isProbe: false };
    }

    const p = this.partition(partitionKey);

    // A user hot-swap (new primary) or a chain edit that dropped the
    // override provider drops the override entirely.
    if (p.overrideId && !chain.includes(p.overrideId)) {
      this.clearOverride(p);
    }

    if (!p.overrideId) {
      return { providerId: primary, isProbe: false };
    }

    // On an override: consider probing the primary.
    const now = this.now();
    const b = this.breaker(p, primary);
    const cooledDown = now >= b.cooldownUntil;
    const throttleOk = now - b.lastProbeAt >= this.resolve().timing.probeThrottleMs;
    if (cooledDown && throttleOk) {
      b.lastProbeAt = now;
      return { providerId: primary, isProbe: true };
    }
    return { providerId: p.overrideId, isProbe: false };
  }

  /**
   * A failure hit `fromId` in partition `partitionKey`. Update its breaker
   * and return the next provider to try this turn, or null when there is
   * nothing left to try (chain exhausted) or the error is not
   * fallover-worthy.
   */
  advanceFrom(
    fromId: string,
    err: unknown,
    partitionKey: string = DEFAULT_PARTITION,
  ): string | null {
    const decision = shouldAdvance(err);
    if (!decision.advance) return null;

    const { chain, timing } = this.resolve();
    const p = this.partition(partitionKey);
    this.registerFailure(p, fromId, decision.immediate, timing);

    const idx = chain.indexOf(fromId);
    // Next healthy link after `fromId`. When `fromId` is not in the chain
    // (raced config edit) start from the top.
    const startFrom = idx < 0 ? 0 : idx + 1;
    for (let i = startFrom; i < chain.length; i += 1) {
      const candidate = chain[i]!;
      if (candidate === fromId) continue;
      this.switchAwayTo(p, chain[0]!, fromId, candidate, err);
      return candidate;
    }
    return null;
  }

  /**
   * A provider answered in partition `partitionKey`. Clear its breaker;
   * fold a successful probe back to primary.
   */
  recordSuccess(
    id: string,
    wasProbe: boolean,
    partitionKey: string = DEFAULT_PARTITION,
  ): void {
    const p = this.partition(partitionKey);
    const b = this.breaker(p, id);
    b.consecutiveFailures = 0;
    b.cooldownUntil = 0;
    b.cooldownStep = 0;
    b.lastFailureAt = 0;

    const { chain } = this.resolve();
    const primary = chain[0];
    if (wasProbe && id === primary && p.overrideId) {
      const from = p.overrideId;
      this.clearOverride(p);
      this.emit({
        direction: "back",
        from,
        to: id,
        reason: "primary recovered",
      });
    }
  }

  /** Test/inspection hook: sticky override on the shared partition. */
  get activeOverride(): string | null {
    return this.partitions.get(DEFAULT_PARTITION)?.overrideId ?? null;
  }

  /** Test/inspection hook: sticky override on a specific partition. */
  activeOverrideFor(partitionKey: string): string | null {
    return this.partitions.get(partitionKey)?.overrideId ?? null;
  }

  private registerFailure(
    p: PartitionState,
    id: string,
    immediate: boolean,
    timing: ResolvedFallbackChain["timing"],
  ): void {
    const now = this.now();
    const b = this.breaker(p, id);

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
    p: PartitionState,
    primary: string,
    fromId: string,
    toId: string,
    err: unknown,
  ): void {
    // Only the first hop off the primary flips the sticky override and
    // announces; deeper hops within the same turn stay silent.
    if (fromId === primary && !p.overrideId) {
      p.overrideId = toId;
      p.announcedOverride = false;
    } else if (p.overrideId) {
      // Chain continued past a dead deeper link — keep the override
      // pointed at the newest working candidate.
      p.overrideId = toId;
    }
    if (!p.announcedOverride) {
      p.announcedOverride = true;
      this.emit({
        direction: "away",
        from: fromId,
        to: toId,
        reason: describeReason(err),
      });
    }
  }

  private clearOverride(p: PartitionState): void {
    p.overrideId = null;
    p.announcedOverride = false;
  }

  private partition(key: string): PartitionState {
    let p = this.partitions.get(key);
    if (!p) {
      p = freshPartition();
      this.partitions.set(key, p);
    }
    return p;
  }

  private breaker(p: PartitionState, id: string): BreakerEntry {
    let b = p.breakers.get(id);
    if (!b) {
      b = freshBreaker();
      p.breakers.set(id, b);
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
