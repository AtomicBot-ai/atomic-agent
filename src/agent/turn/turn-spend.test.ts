import { describe, expect, it } from "vitest";

import type { CompletionResult } from "../../llm/llama-server-client.js";
import {
  costCeilingHeadline,
  costCeilingNotice,
  costCeilingReached,
  recordStepSpend,
  resolveCostCeilingUsd,
} from "./turn-spend.js";
import { formatTaskStoppedReply } from "./turn-finalization.js";

const completion = { content: "", modelId: "m" } as unknown as CompletionResult;

describe("turn spend ceiling helpers", () => {
  it("resolves the ceiling from the turn, then config, with 0 meaning none", () => {
    expect(resolveCostCeilingUsd(undefined, undefined)).toBe(0);
    expect(resolveCostCeilingUsd(undefined, 3)).toBe(3);
    expect(resolveCostCeilingUsd(1.5, 3)).toBe(1.5);
    expect(resolveCostCeilingUsd(0, 3)).toBe(0);
    expect(resolveCostCeilingUsd(-1, 3)).toBe(0);
    expect(resolveCostCeilingUsd(Number.NaN, 3)).toBe(0);
  });

  it("adds priced steps and counts unpriced, broken or missing pricing as $0", () => {
    const turn = { spendUsd: 0, spendPriced: false };
    recordStepSpend(turn, completion, undefined, undefined);
    expect(turn).toEqual({ spendUsd: 0, spendPriced: false });
    recordStepSpend(turn, completion, undefined, () => undefined);
    expect(turn.spendPriced).toBe(false);
    recordStepSpend(turn, completion, "cloud", () => 0.25);
    recordStepSpend(turn, completion, "cloud", () => 0.5);
    recordStepSpend(turn, completion, "cloud", () => Number.NaN);
    recordStepSpend(turn, completion, "cloud", () => -3);
    recordStepSpend(turn, completion, "cloud", () => {
      throw new Error("no catalog");
    });
    expect(turn).toEqual({ spendUsd: 0.75, spendPriced: true });
  });

  it("passes the step's provider to the pricing seam", () => {
    const seen: Array<string | undefined> = [];
    recordStepSpend({ spendUsd: 0, spendPriced: false }, completion, "openrouter", (_c, id) => {
      seen.push(id);
      return 0;
    });
    expect(seen).toEqual(["openrouter"]);
  });

  it("fires only on a set ceiling, at or over it", () => {
    expect(costCeilingReached(100, 0)).toBe(false);
    expect(costCeilingReached(0.99, 1)).toBe(false);
    expect(costCeilingReached(1, 1)).toBe(true);
    expect(costCeilingReached(1.2, 1)).toBe(true);
  });

  it("says the spend in plain words, in the notice and in the synthetic stop", () => {
    expect(costCeilingHeadline(1.2, 1)).toBe("stopped: spent $1.20 of $1.00 budget");
    expect(costCeilingHeadline(0.004, 0.5)).toBe("stopped: spent $0.0040 of $0.50 budget");
    expect(costCeilingNotice(1.2, 1)).toContain("This is the final allowed step.");
    expect(costCeilingNotice(1.2, 1)).toContain('start with "stopped: spent $1.20 of $1.00 budget"');
    const stopped = formatTaskStoppedReply({
      cause: "cost_ceiling",
      stepsTaken: 7,
      stepCeiling: 1000,
      elapsedMs: 120_000,
      budget: { spentUsd: 5.31, ceilingUsd: 5 },
    });
    expect(stopped).toMatch(/^\(stopped: spent \$5\.31 of \$5\.00 budget, after 7 steps over ~2 min\.\)/);
    expect(stopped).toContain("agent.task.maxCostUsd");
  });
});
