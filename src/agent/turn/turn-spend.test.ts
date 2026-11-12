import { describe, expect, it } from "vitest";

import type { CompletionResult } from "../../llm/llama-server-client.js";
import {
  budgetStepPlan,
  costCeilingHeadline,
  costCeilingNotice,
  costCeilingReached,
  recordCompactionSpend,
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

  it("names no spend figure when the summary starts with room left (ATO-1472)", () => {
    const notice = costCeilingNotice(0.8, 1);
    expect(notice).toContain("nearly used up ($0.80 of $1.00");
    expect(notice).toContain('start with "stopped at the $1.00 budget"');
    expect(notice).toContain("This is the final allowed step.");
  });

  it("keeps room for the summary step under a cap (ATO-1472)", () => {
    // No cap: always work.
    expect(budgetStepPlan(100, 5, 0)).toBe("work");
    // First step or a free model: nothing to reserve.
    expect(budgetStepPlan(0, 0, 1)).toBe("work");
    expect(budgetStepPlan(0.9, 0, 1)).toBe("work");
    // Room for one more step and the summary after it.
    expect(budgetStepPlan(0.2, 0.4, 1)).toBe("work");
    // One more step would leave no room for the summary.
    expect(budgetStepPlan(0.4, 0.4, 1)).toBe("summary");
    expect(budgetStepPlan(0.9, 0.04, 1)).toBe("summary");
    // A paid step already reached the cap: no further paid call.
    expect(budgetStepPlan(1, 0.4, 1)).toBe("stop");
    expect(budgetStepPlan(0.02, 0.02, 0.01)).toBe("stop");
    // Reached by compaction alone with a free model: the summary is free.
    expect(budgetStepPlan(1.5, 0, 1)).toBe("summary");
    expect(budgetStepPlan(1, Number.NaN, 1)).toBe("summary");
  });

  it("adds a compaction's summary cost to the turn spend (ATO-1322)", () => {
    const turn = { spendUsd: 0.5, spendPriced: false };
    recordCompactionSpend(turn, 0.25);
    expect(turn).toEqual({ spendUsd: 0.75, spendPriced: true });
    recordCompactionSpend(turn, 0);
    recordCompactionSpend(turn, Number.NaN);
    recordCompactionSpend(turn, -1);
    expect(turn.spendUsd).toBe(0.75);
    expect(costCeilingReached(turn.spendUsd, 0.75)).toBe(true);
  });
});
