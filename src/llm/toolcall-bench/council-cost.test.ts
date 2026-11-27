import { describe, expect, it } from "vitest";

import { councilOverBudget, describeCouncilCost, forecastCouncilCost, type CouncilPrice } from "./council-cost.js";
import { parseCouncilSeats } from "./council-seats.js";

function seats(raw: string) {
  const parsed = parseCouncilSeats(raw, "x");
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.seats;
}

const PRICES: Record<string, CouncilPrice> = {
  "or:a": { kind: "priced", pricing: { input: 1, output: 2 } },
  local: { kind: "free" },
  odd: { kind: "unknown" },
};
const priceOf = (spec: string): CouncilPrice => PRICES[spec] ?? { kind: "unknown" };

describe("forecastCouncilCost (ATO-2432)", () => {
  it("counts every stage: 3 answers, judge, 3 rankers, chairman", () => {
    const f = forecastCouncilCost({ question: "q", seats: seats("or:a*3"), judge: "or:a", chairman: "or:a", rank: true, priceOf });
    expect(f.calls).toBe(8);
    expect(f.maxUsd).toBeGreaterThan(0);
    expect(f.free).toEqual([]);
    expect(f.unpriced).toEqual([]);
  });

  it("leaves out the ranking and chairman when they are off or there is one seat", () => {
    expect(forecastCouncilCost({ question: "q", seats: seats("or:a*3"), judge: "or:a", chairman: null, rank: false, priceOf }).calls).toBe(4);
    expect(forecastCouncilCost({ question: "q", seats: seats("or:a"), judge: "or:a", chairman: "or:a", rank: true, priceOf }).calls).toBe(1);
  });

  it("costs nothing for local seats and lists unpriced ones apart", () => {
    const local = forecastCouncilCost({ question: "q", seats: seats("local*3"), judge: "local", chairman: "local", rank: true, priceOf });
    expect(local.maxUsd).toBe(0);
    expect(local.free).toEqual(["local"]);
    const mixed = forecastCouncilCost({ question: "q", seats: seats("local,odd"), judge: "local", chairman: "local", rank: true, priceOf });
    expect(mixed.unpriced).toEqual(["odd"]);
    expect(describeCouncilCost(mixed)).toBe("Up to 4 requests, at most $0.00 (free: local; price unknown: odd)");
  });

  it("a local seat makes the cloud part smaller than three cloud seats", () => {
    const cloud = forecastCouncilCost({ question: "q", seats: seats("or:a*3"), judge: "or:a", chairman: "or:a", rank: true, priceOf });
    const mixed = forecastCouncilCost({ question: "q", seats: seats("or:a,local*2"), judge: "or:a", chairman: "or:a", rank: true, priceOf });
    expect(mixed.maxUsd).toBeLessThan(cloud.maxUsd);
  });

  it("refuses a council over the ceiling before anything is sent", () => {
    const f = forecastCouncilCost({ question: "q", seats: seats("or:a*3"), judge: "or:a", chairman: "or:a", rank: true, priceOf });
    expect(councilOverBudget(f, undefined)).toBeNull();
    expect(councilOverBudget(f, f.maxUsd)).toBeNull();
    expect(councilOverBudget(f, f.maxUsd / 2)).toMatch(/over the \$\d+\.\d+ limit; nothing was sent$/);
  });
});
