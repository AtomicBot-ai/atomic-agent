import { describe, expect, it } from "vitest";
import {
  EMPTY_SESSION_USAGE,
  SessionUsageLedger,
  STALE_READING_MS,
  activeLimits,
  forwardWorkerUsage,
  formatLimit,
  formatDailySpend,
  formatResetTime,
  formatSessionCost,
  formatUsageReport,
  pickHeadlineLimit,
  priceCompletion,
  usageStatusParts,
  type LimitReading,
  type SessionUsageState,
} from "./usage-meter.js";

const NOW = new Date(2026, 10, 6, 12, 0, 0).getTime();
const usage = { promptTokens: 1_000_000, completionTokens: 100_000, totalTokens: 1_100_000 };
const priced = { pricing: { input: 3, output: 15 }, source: "catalog" as const };

function reading(over: Partial<LimitReading>): LimitReading {
  return {
    scope: "subscription",
    name: "5h",
    providerId: "codex",
    modelId: null,
    observedAt: NOW,
    ...over,
  };
}

describe("priceCompletion", () => {
  it("prefers what the provider billed over the price table", () => {
    expect(priceCompletion({ usage: { ...usage, costUsd: 0.42 }, model: priced, local: false })).toEqual({
      kind: "priced",
      usd: 0.42,
      source: "provider",
    });
  });

  it("prices from the configured or catalog price, naming the source", () => {
    expect(priceCompletion({ usage, model: priced, local: false })).toEqual({
      kind: "priced",
      usd: 3 + 1.5,
      source: "catalog",
    });
    expect(
      priceCompletion({ usage, model: { ...priced, source: "user" }, local: false }),
    ).toMatchObject({ source: "user" });
  });

  it("never turns an unknown price into $0", () => {
    expect(priceCompletion({ usage, local: false })).toEqual({ kind: "unpriced" });
  });

  it("calls a local model local, and a subscription CLI plan-billed", () => {
    expect(priceCompletion({ usage, model: priced, local: true })).toEqual({ kind: "local" });
    expect(priceCompletion({ usage, local: false, plan: true })).toEqual({ kind: "plan" });
  });

  it("has nothing to count without usage", () => {
    expect(priceCompletion({ local: false })).toEqual({ kind: "none" });
  });
});

describe("SessionUsageLedger", () => {
  it("sums priced calls per session and tells the listener", () => {
    const seen: Array<[string, number]> = [];
    const ledger = new SessionUsageLedger({ now: () => NOW, onChange: (id, s) => seen.push([id, s.costUsd]) });
    ledger.record("a", { providerId: "openrouter", modelId: "m", usage, model: priced, local: false });
    ledger.record("a", { providerId: "openrouter", modelId: "m", usage, model: priced, local: false });
    ledger.record("b", { providerId: "openrouter", modelId: "m", usage, model: priced, local: false });
    expect(ledger.get("a")?.costUsd).toBeCloseTo(9);
    expect(ledger.get("a")?.pricedCalls).toBe(2);
    expect(ledger.get("b")?.costUsd).toBeCloseTo(4.5);
    expect(seen.map(([id]) => id)).toEqual(["a", "a", "b"]);
  });

  it("counts a fusion worker's calls on the session that spawned it (ATO-1388)", () => {
    const seen: string[] = [];
    const ledger = new SessionUsageLedger({ now: () => NOW, onChange: (id) => seen.push(id) });
    ledger.record("s-parent", { providerId: "openrouter", modelId: "m", usage, model: priced, local: false });
    ledger.forward("s-w-1", "s-parent");
    ledger.record("s-w-1", { providerId: "openrouter", modelId: "m", usage, model: priced, local: false });
    ledger.record("s-w-1", { providerId: "openrouter", modelId: "x", usage, local: false });
    ledger.record("s-w-1", { providerId: "llama", modelId: "q", usage, local: true });
    const parent = ledger.get("s-parent");
    expect(parent?.costUsd).toBeCloseTo(9);
    expect(parent?.pricedCalls).toBe(2);
    expect(parent?.unpricedCalls).toBe(1);
    expect(parent?.localCalls).toBe(1);
    expect(formatSessionCost(parent)).toBe("$9.00+");
    expect(ledger.get("s-w-1")).toBeUndefined();
    expect(seen.every((id) => id === "s-parent")).toBe(true);
  });

  it("links every worker the wrapped factory mints to its parent (ATO-1388)", () => {
    const ledger = new SessionUsageLedger({ now: () => NOW });
    const create = forwardWorkerUsage(
      (meta: { parentSessionId: string; taskId: string }, dir?: string) => ({ id: `s-w-${meta.taskId}`, dir }),
      ledger,
    );
    expect(create({ parentSessionId: "s-parent", taskId: "t1" }, "/repo")).toEqual({ id: "s-w-t1", dir: "/repo" });
    ledger.record("s-w-t1", { providerId: "openrouter", modelId: "m", usage, model: priced, local: false });
    expect(ledger.get("s-parent")?.costUsd).toBeCloseTo(4.5);
    expect(ledger.get("s-w-t1")).toBeUndefined();
  });

  it("continues from what a reopened session persisted, once", () => {
    const ledger = new SessionUsageLedger({ now: () => NOW });
    const stored: SessionUsageState = { ...EMPTY_SESSION_USAGE, costUsd: 1, pricedCalls: 1, costSources: ["catalog"] };
    ledger.seed("a", stored);
    ledger.record("a", { providerId: "p", modelId: "m", usage, model: priced, local: false });
    ledger.seed("a", stored);
    expect(ledger.get("a")?.costUsd).toBeCloseTo(5.5);
  });

  it("shares an account's limit reading across sessions and replaces it by window", () => {
    let now = NOW;
    const ledger = new SessionUsageLedger({ now: () => now });
    ledger.record("a", {
      providerId: "codex",
      modelId: null,
      local: false,
      plan: true,
      usage,
      rateLimits: [{ scope: "subscription", name: "5h", usedPercent: 50, resetsAt: NOW + 3_600_000 }],
    });
    now += 1000;
    const b = ledger.record("b", {
      providerId: "codex",
      modelId: null,
      local: false,
      plan: true,
      usage,
      rateLimits: [{ scope: "subscription", name: "5h", usedPercent: 60, resetsAt: NOW + 3_600_000 }],
    });
    expect(b.limits).toHaveLength(1);
    expect(b.limits[0]?.usedPercent).toBe(60);
    expect(b.planCalls).toBe(1);
  });

  it("clears a reading once its reset time has passed", () => {
    let now = NOW;
    const ledger = new SessionUsageLedger({ now: () => now });
    ledger.record("a", {
      providerId: "codex",
      modelId: null,
      local: false,
      rateLimits: [{ scope: "subscription", name: "5h", usedPercent: 99, resetsAt: NOW + 1000 }],
    });
    now += 2000;
    const after = ledger.record("a", { providerId: "openrouter", modelId: "m", usage, model: priced, local: false });
    expect(after.limits).toEqual([]);
  });
});

describe("activeLimits", () => {
  it("keeps a reading without a reset only while it is fresh", () => {
    const r = reading({ resetsAt: undefined, usedPercent: 10 });
    expect(activeLimits([r], NOW + STALE_READING_MS - 1)).toHaveLength(1);
    expect(activeLimits([r], NOW + STALE_READING_MS)).toHaveLength(0);
  });
});

describe("status line", () => {
  it("shows only the parts that have data", () => {
    expect(usageStatusParts(undefined, NOW)).toEqual([]);
    expect(usageStatusParts(EMPTY_SESSION_USAGE, NOW)).toEqual([]);
    const state: SessionUsageState = {
      ...EMPTY_SESSION_USAGE,
      costUsd: 0.3112,
      pricedCalls: 3,
      limits: [reading({ usedPercent: 83, resetsAt: new Date(2026, 10, 6, 15, 0).getTime() })],
    };
    expect(usageStatusParts(state, NOW)).toEqual(["$0.31", "17% left, resets 15:00"]);
  });

  it("adds today's spend after the session's when the runtime stamped it (ATO-649)", () => {
    const today = { day: "2026-11-06", usd: 1.2, pricedCalls: 4, unpricedCalls: 0 };
    const state: SessionUsageState = { ...EMPTY_SESSION_USAGE, costUsd: 0.31, pricedCalls: 2, today };
    expect(usageStatusParts(state, NOW)).toEqual(["$0.31", "today $1.20"]);
    expect(
      usageStatusParts({ ...state, today: { ...today, limitUsd: 5 } }, NOW),
    ).toEqual(["$0.31", "today $1.20 of $5.00"]);
  });

  it("shows no day total it cannot price, but always the ceiling it is held to", () => {
    const empty = { day: "2026-11-06", usd: 0, pricedCalls: 0, unpricedCalls: 3 };
    expect(formatDailySpend(undefined)).toBeNull();
    expect(formatDailySpend(empty)).toBeNull();
    expect(formatDailySpend({ ...empty, limitUsd: 5 })).toBe("today $0.00+ of $5.00");
    expect(formatDailySpend({ ...empty, usd: 0.5, pricedCalls: 1 })).toBe("today $0.50+");
  });

  it("is honest about spend it cannot price", () => {
    const base = EMPTY_SESSION_USAGE;
    expect(formatSessionCost({ ...base, unpricedCalls: 2 })).toBe("cost n/a");
    expect(formatSessionCost({ ...base, costUsd: 0.5, pricedCalls: 1, unpricedCalls: 1 })).toBe("$0.50+");
    expect(formatSessionCost({ ...base, localCalls: 4 })).toBe("local");
    expect(formatSessionCost({ ...base, planCalls: 4 })).toBe("plan");
    expect(formatSessionCost({ ...base, costUsd: 0.004, pricedCalls: 1 })).toBe("$0.004");
  });

  it("leads with the subscription window closest to its end", () => {
    const headline = pickHeadlineLimit(
      [
        reading({ name: "5h", usedPercent: 40, resetsAt: NOW + 1000 }),
        reading({ name: "weekly", usedPercent: 90, resetsAt: NOW + 100_000 }),
        reading({ scope: "api", name: "tokens", usedPercent: 99, resetsAt: NOW + 1000 }),
      ],
      NOW,
    );
    expect(headline?.name).toBe("weekly");
  });

  it("shows an API budget only once it is mostly spent", () => {
    expect(pickHeadlineLimit([reading({ scope: "api", name: "requests", usedPercent: 10 })], NOW)).toBeNull();
    expect(
      pickHeadlineLimit([reading({ scope: "api", name: "requests", usedPercent: 85 })], NOW)?.name,
    ).toBe("requests");
  });

  it("says when the limit is reached", () => {
    expect(formatLimit(reading({ status: "rejected" }), NOW)).toBe("limit reached");
    expect(formatLimit(reading({ usedPercent: 100 }), NOW)).toBe("limit reached");
    expect(formatLimit(reading({ status: "allowed_warning" }), NOW)).toBe("near limit");
  });
});

describe("formatResetTime", () => {
  it("prints a time today, a weekday this week, a date beyond", () => {
    expect(formatResetTime(new Date(2026, 10, 6, 15, 5).getTime(), NOW)).toBe("15:05");
    expect(formatResetTime(new Date(2026, 10, 7, 9, 0).getTime(), NOW)).toMatch(/^[A-Z][a-z]{2} 09:00$/);
    expect(formatResetTime(new Date(2026, 10, 20, 9, 0).getTime(), NOW)).toMatch(/20 Nov/);
  });
});

describe("formatUsageReport", () => {
  it("says plainly when there is no limit reading", () => {
    const text = formatUsageReport(undefined, NOW);
    expect(text).toContain("nothing recorded yet");
    expect(text).toContain("limits: no reading yet");
  });

  it("lists unpriced models and every live window", () => {
    const text = formatUsageReport(
      {
        ...EMPTY_SESSION_USAGE,
        costUsd: 1.2,
        pricedCalls: 2,
        unpricedCalls: 1,
        unpricedModels: ["my/custom"],
        costSources: ["provider"],
        limits: [reading({ scope: "api", name: "requests", remaining: 5, limit: 20, usedPercent: 75 })],
      },
      NOW,
    );
    expect(text).toContain("$1.20 over 2 priced calls (prices from the provider's bill)");
    expect(text).toContain("my/custom");
    expect(text).toContain("codex api requests: 25% left (5 of 20 left)");
  });
});
