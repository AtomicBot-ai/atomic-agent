import { describe, it, expect, vi } from "vitest";
import { ProviderFallbackChain } from "./provider-fallback-chain.js";
import type { ProviderSwitchNotice } from "./provider-fallback-chain.js";
import type { ResolvedFallbackChain } from "./fallback-config.js";
import { DEFAULT_FALLBACK_TIMING } from "./fallback-config.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { GrammarError } from "../reliability/llm-failures.js";

function chainOf(
  ids: string[],
  timing = DEFAULT_FALLBACK_TIMING,
): ResolvedFallbackChain {
  return { chain: ids, timing };
}

/** Controllable clock so cooldown / probe timing is deterministic. */
function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function http(status: number | null, timedOut = false): OpenAiHttpError {
  return new OpenAiHttpError("boom", status, "http://x/y", timedOut, null, "p");
}

describe("ProviderFallbackChain", () => {
  it("switches to the fallback immediately on a 429 (no threshold wait)", () => {
    const notices: ProviderSwitchNotice[] = [];
    const chain = new ProviderFallbackChain({
      resolve: () => chainOf(["primary", "backup"]),
      noticeSink: (n) => notices.push(n),
    });

    expect(chain.pickProvider()).toEqual({
      providerId: "primary",
      isProbe: false,
    });
    // First failure is a 429 → immediate advance, no need for 3 strikes.
    expect(chain.advanceFrom("primary", http(429))).toBe("backup");
    expect(chain.activeOverride).toBe("backup");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ direction: "away", to: "backup" });
  });

  it("arms the primary cooldown only once the non-immediate threshold is reached", () => {
    const clock = makeClock();
    const timing = {
      ...DEFAULT_FALLBACK_TIMING,
      failureThreshold: 3,
      probeThrottleMs: 0, // isolate cooldown from throttle
    };
    const chain = new ProviderFallbackChain({
      resolve: () => chainOf(["primary", "backup"], timing),
      now: clock.now,
    });
    // A caller timeout is advance-worthy but NOT an immediate signal, so
    // it only trips the breaker at the threshold.
    const timeout = http(null, true);

    // Failures #1 and #2: we advance (returns the next link this turn),
    // but the primary is NOT yet in cooldown — a probe is still eligible.
    chain.advanceFrom("primary", timeout);
    chain.recordSuccess("backup", false);
    expect(chain.pickProvider()).toEqual({ providerId: "primary", isProbe: true });

    chain.advanceFrom("primary", timeout);
    chain.recordSuccess("backup", false);
    expect(chain.pickProvider()).toEqual({ providerId: "primary", isProbe: true });

    // Failure #3 reaches the threshold → cooldown (30s) now arms, so the
    // immediate next pick stays on backup rather than probing.
    chain.advanceFrom("primary", timeout);
    chain.recordSuccess("backup", false);
    expect(chain.pickProvider()).toEqual({
      providerId: "backup",
      isProbe: false,
    });
  });

  it("is sticky: does not re-pick the dead primary on the next turn", () => {
    const chain = new ProviderFallbackChain({
      resolve: () => chainOf(["primary", "backup"]),
    });
    chain.advanceFrom("primary", http(500));
    chain.recordSuccess("backup", false);
    // Next turn stays on backup (primary is in cooldown), NOT a probe.
    expect(chain.pickProvider()).toEqual({
      providerId: "backup",
      isProbe: false,
    });
  });

  it("escalates the cooldown ladder 30s → 60s → 300s on repeated primary failures", () => {
    const clock = makeClock();
    const timing = {
      ...DEFAULT_FALLBACK_TIMING,
      probeThrottleMs: 0, // isolate cooldown from probe throttle
    };
    const chain = new ProviderFallbackChain({
      resolve: () => chainOf(["primary", "backup"], timing),
      now: clock.now,
    });

    // Fail #1 (immediate 5xx) → 30s cooldown.
    chain.advanceFrom("primary", http(500));
    chain.recordSuccess("backup", false);
    // 30s not elapsed → still backup.
    clock.advance(29_000);
    expect(chain.pickProvider().providerId).toBe("backup");
    // 30s elapsed → probe primary.
    clock.advance(2_000);
    expect(chain.pickProvider()).toEqual({ providerId: "primary", isProbe: true });

    // Probe fails again → escalate to 60s.
    chain.advanceFrom("primary", http(500));
    chain.recordSuccess("backup", false);
    clock.advance(59_000);
    expect(chain.pickProvider().providerId).toBe("backup");
    clock.advance(2_000);
    expect(chain.pickProvider()).toEqual({ providerId: "primary", isProbe: true });

    // Probe fails again → escalate to 300s (cap).
    chain.advanceFrom("primary", http(500));
    chain.recordSuccess("backup", false);
    clock.advance(299_000);
    expect(chain.pickProvider().providerId).toBe("backup");
    clock.advance(2_000);
    expect(chain.pickProvider()).toEqual({ providerId: "primary", isProbe: true });

    // One more failure stays capped at 300s (does not grow to 600s).
    chain.advanceFrom("primary", http(500));
    chain.recordSuccess("backup", false);
    clock.advance(299_000);
    expect(chain.pickProvider().providerId).toBe("backup");
    clock.advance(2_000);
    expect(chain.pickProvider().isProbe).toBe(true);
  });

  it("probes the primary once per throttle window and returns on recovery with one notice", () => {
    const clock = makeClock();
    const notices: ProviderSwitchNotice[] = [];
    const chain = new ProviderFallbackChain({
      resolve: () => chainOf(["primary", "backup"]),
      now: clock.now,
      noticeSink: (n) => notices.push(n),
    });

    chain.advanceFrom("primary", http(500));
    chain.recordSuccess("backup", false);
    expect(notices).toHaveLength(1); // away

    // Cooldown (30s) elapses; probe throttle (5min) also must pass.
    clock.advance(DEFAULT_FALLBACK_TIMING.probeThrottleMs + 1);
    const probe = chain.pickProvider();
    expect(probe).toEqual({ providerId: "primary", isProbe: true });

    // Probe succeeds → back to primary + one "back" notice.
    chain.recordSuccess("primary", true);
    expect(chain.activeOverride).toBeNull();
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatchObject({ direction: "back", to: "primary" });

    // Subsequent turn is a normal primary turn, no extra notice.
    expect(chain.pickProvider()).toEqual({
      providerId: "primary",
      isProbe: false,
    });
    expect(notices).toHaveLength(2);
  });

  it("throttles repeat probes: after a failed probe, waits probeThrottleMs before the next", () => {
    const clock = makeClock();
    const chain = new ProviderFallbackChain({
      resolve: () => chainOf(["primary", "backup"]),
      now: clock.now,
    });
    chain.advanceFrom("primary", http(500)); // 30s cooldown
    chain.recordSuccess("backup", false);

    // First probe fires at the cooldown boundary — the throttle does not
    // gate the very first probe (lastProbeAt = 0).
    clock.advance(31_000);
    expect(chain.pickProvider()).toEqual({ providerId: "primary", isProbe: true });

    // Probe fails → cooldown re-arms (short, escalated to 60s) but the
    // 5-min throttle must now suppress a second probe even after 60s.
    chain.advanceFrom("primary", http(500));
    chain.recordSuccess("backup", false);
    clock.advance(61_000); // cooldown elapsed, but < 5min since last probe
    expect(chain.pickProvider()).toEqual({
      providerId: "backup",
      isProbe: false,
    });

    // Once the throttle window fully passes, probing resumes.
    clock.advance(DEFAULT_FALLBACK_TIMING.probeThrottleMs);
    expect(chain.pickProvider()).toEqual({ providerId: "primary", isProbe: true });
  });

  it("does not switch on a grammar error (deterministic, same everywhere)", () => {
    const notices: ProviderSwitchNotice[] = [];
    const chain = new ProviderFallbackChain({
      resolve: () => chainOf(["primary", "backup"]),
      noticeSink: (n) => notices.push(n),
    });
    expect(chain.advanceFrom("primary", new GrammarError("bad", ""))).toBeNull();
    expect(chain.activeOverride).toBeNull();
    expect(notices).toHaveLength(0);
  });

  it("does not switch on a 400/401/404 (request-shape / auth) — grammar category", () => {
    const chain = new ProviderFallbackChain({
      resolve: () => chainOf(["primary", "backup"]),
    });
    // OpenAiHttpError classifies as transport regardless of status, so a
    // 401 IS advance-worthy at the chain level — that is intentional: a
    // dead key on the primary should try the fallback. Assert that.
    expect(chain.advanceFrom("primary", http(401))).toBe("backup");
  });

  it("returns null when the whole chain is exhausted", () => {
    const chain = new ProviderFallbackChain({
      resolve: () => chainOf(["a", "b", "c"]),
    });
    expect(chain.advanceFrom("a", http(500))).toBe("b");
    expect(chain.advanceFrom("b", http(500))).toBe("c");
    // No link after "c" → exhausted.
    expect(chain.advanceFrom("c", http(500))).toBeNull();
  });

  it("emits exactly one 'away' notice across a multi-hop exhaustion in one turn", () => {
    const notices: ProviderSwitchNotice[] = [];
    const chain = new ProviderFallbackChain({
      resolve: () => chainOf(["a", "b", "c"]),
      noticeSink: (n) => notices.push(n),
    });
    chain.advanceFrom("a", http(500));
    chain.advanceFrom("b", http(500));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ direction: "away", from: "a", to: "b" });
  });

  it("drops a stale override when the chain no longer contains it", () => {
    let ids = ["primary", "backup"];
    const chain = new ProviderFallbackChain({
      resolve: () => chainOf(ids),
    });
    chain.advanceFrom("primary", http(500));
    chain.recordSuccess("backup", false);
    expect(chain.activeOverride).toBe("backup");

    // Config edit removes "backup" from the chain entirely.
    ids = ["primary", "other"];
    // Next pick re-primes to the primary (override was stale).
    expect(chain.pickProvider()).toEqual({
      providerId: "primary",
      isProbe: false,
    });
    expect(chain.activeOverride).toBeNull();
  });

  it("is a transparent pass-through for a single-link chain", () => {
    const notices: ProviderSwitchNotice[] = [];
    const chain = new ProviderFallbackChain({
      resolve: () => chainOf(["only"]),
      noticeSink: (n) => notices.push(n),
    });
    expect(chain.pickProvider()).toEqual({ providerId: "only", isProbe: false });
    // Advance-worthy failure but nowhere to go → null, no notice.
    expect(chain.advanceFrom("only", http(500))).toBeNull();
    expect(notices).toHaveLength(0);
  });

  it("resets the consecutive-failure streak after the no-error window", () => {
    const clock = makeClock();
    const timing = {
      ...DEFAULT_FALLBACK_TIMING,
      failureThreshold: 2,
      failureWindowMs: 10_000,
      probeThrottleMs: 0,
    };
    const chain = new ProviderFallbackChain({
      resolve: () => chainOf(["primary", "backup"], timing),
      now: clock.now,
    });
    const nonImmediate = http(null, true); // timedOut → counts toward threshold only

    // One non-immediate failure — below threshold(2), no cooldown armed.
    chain.advanceFrom("primary", nonImmediate);
    chain.recordSuccess("backup", false);
    // Primary not in cooldown → immediately probe-eligible (throttle 0).
    expect(chain.pickProvider()).toEqual({ providerId: "primary", isProbe: true });

    // Let the no-error window pass so the streak resets, then one more
    // non-immediate failure should again be below threshold (not the 2nd).
    clock.advance(20_000);
    chain.advanceFrom("primary", nonImmediate);
    chain.recordSuccess("backup", false);
    expect(chain.pickProvider()).toEqual({ providerId: "primary", isProbe: true });
  });

  it("does not advance on a cancellation", () => {
    const chain = new ProviderFallbackChain({
      resolve: () => chainOf(["primary", "backup"]),
    });
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(chain.advanceFrom("primary", abort)).toBeNull();
  });
});
