import { describe, expect, it } from "vitest";

import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { DEFAULT_FALLBACK_TIMING } from "./fallback-config.js";
import { ProviderFallbackChain } from "./provider-fallback-chain.js";
import {
  armTurnHeadCooldown,
  TURN_HEAD_COOLDOWN_MS,
  turnHeadResting,
  type TurnHeadCooldown,
} from "./turn-head-cooldown.js";

describe("turn head cooldown (ATO-2435)", () => {
  it("rests longer on each failure in a row, capped at the last step", () => {
    const map = new Map<string, TurnHeadCooldown>();
    armTurnHeadCooldown(map, "local", 0);
    expect(map.get("local")).toEqual({ until: TURN_HEAD_COOLDOWN_MS[0], failures: 1 });
    armTurnHeadCooldown(map, "local", 1_000);
    expect(map.get("local")?.until).toBe(1_000 + TURN_HEAD_COOLDOWN_MS[1]!);
    armTurnHeadCooldown(map, "local", 2_000);
    armTurnHeadCooldown(map, "local", 3_000);
    expect(map.get("local")?.until).toBe(3_000 + TURN_HEAD_COOLDOWN_MS.at(-1)!);
  });

  it("rests until the instant, not after it", () => {
    const map = new Map<string, TurnHeadCooldown>();
    armTurnHeadCooldown(map, "local", 0, [100]);
    expect(turnHeadResting(map, "local", 99)).toBe(true);
    expect(turnHeadResting(map, "local", 100)).toBe(false);
    expect(turnHeadResting(map, "other", 0)).toBe(false);
  });
});

describe("ProviderFallbackChain.turnHeadCoolingDown (ATO-2435)", () => {
  function chainAt(clock: { now: number }) {
    return new ProviderFallbackChain({
      resolve: () => ({ chain: ["openrouter"], timing: DEFAULT_FALLBACK_TIMING }),
      now: () => clock.now,
    });
  }
  const down = () => new OpenAiHttpError("down", 503, "http://127.0.0.1:8080", false, null, "local");

  it("a failed head rests on the next turn even though the head is reset, then recovers", () => {
    const clock = { now: 1_000 };
    const chain = chainAt(clock);
    chain.setTurnPrimary("s1", "local");
    expect(chain.advanceFrom("local", down(), "s1")).toBe("openrouter");
    chain.setTurnPrimary("s1", null);

    expect(chain.turnHeadCoolingDown("s1", "local")).toBe(true);
    // Another session has its own partition.
    expect(chain.turnHeadCoolingDown("s2", "local")).toBe(false);

    clock.now += TURN_HEAD_COOLDOWN_MS[0]!;
    expect(chain.turnHeadCoolingDown("s1", "local")).toBe(false);
  });

  it("one timeout of the head is enough, below the breaker threshold", () => {
    const clock = { now: 1_000 };
    const chain = chainAt(clock);
    chain.setTurnPrimary("s1", "local");
    const timedOut = new OpenAiHttpError("timed out", null, "http://127.0.0.1:8080", true, null, "local");
    expect(chain.advanceFrom("local", timedOut, "s1")).toBe("openrouter");
    expect(chain.turnHeadCoolingDown("s1", "local")).toBe(true);
  });

  it("an answer from the head clears its rest and the ladder", () => {
    const clock = { now: 1_000 };
    const chain = chainAt(clock);
    chain.setTurnPrimary("s1", "local");
    chain.advanceFrom("local", down(), "s1");
    chain.recordSuccess("local", false, "s1");
    expect(chain.turnHeadCoolingDown("s1", "local")).toBe(false);
  });

  it("a failure of a link that is not the head arms nothing", () => {
    const clock = { now: 1_000 };
    const chain = new ProviderFallbackChain({
      resolve: () => ({ chain: ["openrouter", "local"], timing: DEFAULT_FALLBACK_TIMING }),
      now: () => clock.now,
    });
    chain.advanceFrom("local", down(), "s1");
    expect(chain.turnHeadCoolingDown("s1", "local")).toBe(false);
  });
});
