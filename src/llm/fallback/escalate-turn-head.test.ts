import { describe, expect, it } from "vitest";

import { DEFAULT_FALLBACK_TIMING } from "./fallback-config.js";
import { ProviderFallbackChain, type ProviderSwitchNotice } from "./provider-fallback-chain.js";

function chainAt(clock: { now: number }, notices: ProviderSwitchNotice[] = []) {
  return new ProviderFallbackChain({
    resolve: () => ({ chain: ["openrouter"], timing: DEFAULT_FALLBACK_TIMING }),
    now: () => clock.now,
    noticeSink: (n) => notices.push(n),
  });
}

describe("ProviderFallbackChain.escalateTurnHead (ATO-2434)", () => {
  it("moves the rest of the turn off its head and says why", () => {
    const notices: ProviderSwitchNotice[] = [];
    const chain = chainAt({ now: 1_000 }, notices);
    chain.setTurnPrimary("s1", "local");
    expect(chain.escalateTurnHead("s1", "the local model's answer was empty")).toBe("openrouter");
    expect(chain.pickProvider("s1")).toEqual({ providerId: "openrouter", isProbe: false });
    expect(chain.standingOverrideFor("s1")).toBe("openrouter");
    expect(notices).toEqual([
      { direction: "away", from: "local", to: "openrouter", reason: "the local model's answer was empty" },
    ]);
  });

  it("does not probe the head again within the turn", () => {
    const clock = { now: 1_000 };
    const chain = chainAt(clock);
    chain.setTurnPrimary("s1", "local");
    chain.escalateTurnHead("s1", "weak");
    clock.now += DEFAULT_FALLBACK_TIMING.probeThrottleMs - 1;
    expect(chain.pickProvider("s1").providerId).toBe("openrouter");
  });

  it("leaves the head's rest alone and gives the next turn its head back", () => {
    const chain = chainAt({ now: 1_000 });
    chain.setTurnPrimary("s1", "local");
    chain.escalateTurnHead("s1", "weak");
    expect(chain.turnHeadCoolingDown("s1", "local")).toBe(false);
    chain.setTurnPrimary("s1", null);
    chain.setTurnPrimary("s1", "local");
    expect(chain.pickProvider("s1").providerId).toBe("local");
  });

  it("does nothing without a head, once the turn left it, or with nothing after it", () => {
    const chain = chainAt({ now: 1_000 });
    expect(chain.escalateTurnHead("s1", "weak")).toBeNull();
    chain.setTurnPrimary("s1", "local");
    chain.escalateTurnHead("s1", "weak");
    expect(chain.escalateTurnHead("s1", "weak again")).toBeNull();

    const alone = new ProviderFallbackChain({
      resolve: () => ({ chain: [], timing: DEFAULT_FALLBACK_TIMING }),
    });
    alone.setTurnPrimary("s1", "local");
    expect(alone.escalateTurnHead("s1", "weak")).toBeNull();
  });
});
