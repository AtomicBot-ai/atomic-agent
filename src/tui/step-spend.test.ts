import { describe, expect, it } from "vitest";
import { EMPTY_SESSION_USAGE, type SessionUsageState } from "../session/usage-meter.js";
import { addStepSpend, knownStepCostUsd } from "./step-spend.js";

// ATO-34: `/why` shows a step's dollar cost only when the runtime priced every call of it.

function usage(extra: Partial<SessionUsageState>): SessionUsageState {
  return { ...EMPTY_SESSION_USAGE, ...extra };
}

describe("addStepSpend", () => {
  it("keeps the difference between two readings on the running step", () => {
    const first = addStepSpend({}, null, usage({ costUsd: 0.01, pricedCalls: 1 }), 0);
    const second = addStepSpend(
      first,
      usage({ costUsd: 0.01, pricedCalls: 1 }),
      usage({ costUsd: 0.04, pricedCalls: 3 }),
      0,
    );
    expect(second[0]?.usd).toBeCloseTo(0.04);
    expect(second[0]?.pricedCalls).toBe(3);
  });

  it("ignores a reading that counted no call or went backwards", () => {
    const before = usage({ costUsd: 0.5, pricedCalls: 4 });
    expect(addStepSpend({}, before, { ...before, updatedAt: 9 }, 2)).toEqual({});
    expect(addStepSpend({}, before, usage({ costUsd: 0.1, pricedCalls: 1 }), 2)).toEqual({});
  });
});

describe("knownStepCostUsd", () => {
  const base = { usd: 0.0123, pricedCalls: 1, unpricedCalls: 0, localCalls: 0, planCalls: 0 };

  it("returns the priced sum, also beside free local calls", () => {
    expect(knownStepCostUsd(base)).toBeCloseTo(0.0123);
    expect(knownStepCostUsd({ ...base, localCalls: 2 })).toBeCloseTo(0.0123);
  });

  it("returns null for a local, plan-only or unpriced step, and for no data", () => {
    expect(knownStepCostUsd(undefined)).toBeNull();
    expect(knownStepCostUsd({ ...base, usd: 0, pricedCalls: 0, localCalls: 1 })).toBeNull();
    expect(knownStepCostUsd({ ...base, usd: 0, pricedCalls: 0, planCalls: 1 })).toBeNull();
    expect(knownStepCostUsd({ ...base, unpricedCalls: 1 })).toBeNull();
  });
});
