import { afterEach, describe, expect, it } from "vitest";

import { MODEL_TIERS } from "../llm/provider/presets/model-tiers.js";
import { startTestHarness, type Harness } from "./test-harness.js";

describe("GET /api/model-tiers (ATO-32)", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
  });

  it("serves the one data file's picks, Cheap / Balanced / Best in order", async () => {
    harness = await startTestHarness();
    const res = await fetch(`${harness.baseUrl}/api/model-tiers`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tiers: Record<string, Array<{ tier: string; label: string; model: string }>> };
    expect(Object.keys(body.tiers).sort()).toEqual(Object.keys(MODEL_TIERS).sort());
    expect(body.tiers.openrouter).toEqual([
      { tier: "cheap", label: "Cheap", model: MODEL_TIERS.openrouter!.cheap },
      { tier: "balanced", label: "Balanced", model: MODEL_TIERS.openrouter!.balanced },
      { tier: "best", label: "Best", model: MODEL_TIERS.openrouter!.best },
    ]);
  });
});
