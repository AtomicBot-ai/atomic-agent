import { describe, expect, it } from "vitest";

import { CostAccumulator } from "./cost-accumulator.js";
import type { ResolvedModel } from "./model-resolver.js";

const priced = { pricing: { input: 1, output: 2 } } as unknown as ResolvedModel;
const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 };

describe("CostAccumulator", () => {
  it("estimates from the price table when the service reports no cost", () => {
    const acc = new CostAccumulator();
    acc.recordTurn({ modelId: "m", usage, model: priced });
    expect(acc.snapshot().sessionUsd).toBeCloseTo(3, 9);
  });

  it("prefers the provider-billed cost over the price table (ATO-1289)", () => {
    const acc = new CostAccumulator();
    acc.recordTurn({ modelId: "m", usage: { ...usage, costUsd: 0.25 }, model: priced });
    expect(acc.snapshot()).toMatchObject({ sessionUsd: 0.25, dayUsd: 0.25, lastTurnUsd: 0.25 });
  });

  it("counts a billed cost even for a model the table does not price", () => {
    const acc = new CostAccumulator();
    acc.recordTurn({ modelId: "m", usage: { ...usage, costUsd: 0.1 } });
    expect(acc.snapshot().sessionUsd).toBeCloseTo(0.1, 9);
  });

  it("ignores a malformed billed cost and falls back to the estimate", () => {
    const acc = new CostAccumulator();
    acc.recordTurn({ modelId: "m", usage: { ...usage, costUsd: Number.NaN }, model: priced });
    acc.recordTurn({ modelId: "m", usage: { ...usage, costUsd: -1 }, model: priced });
    expect(acc.snapshot().sessionUsd).toBeCloseTo(6, 9);
  });

  it("records nothing priced without usage", () => {
    const acc = new CostAccumulator();
    acc.recordTurn({ modelId: "m", model: priced });
    expect(acc.snapshot().sessionUsd).toBe(0);
  });
});
