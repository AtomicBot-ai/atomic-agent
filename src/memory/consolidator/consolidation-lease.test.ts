import { describe, expect, it } from "vitest";

import { consolidationLeaseMs } from "./consolidation-lease.js";
import { ConsolidatorJob } from "./consolidator-job.js";

describe("consolidationLeaseMs (ATO-2506)", () => {
  it("keeps the 60 s floor for the default 45 s distill timeout", () => {
    expect(consolidationLeaseMs(45_000)).toBe(60_000);
  });

  it("outlives a distill timeout longer than the floor by 15 s", () => {
    expect(consolidationLeaseMs(120_000)).toBe(135_000);
    expect(consolidationLeaseMs(50_000)).toBe(65_000);
  });

  it("falls back to the floor for a missing or broken timeout", () => {
    expect(consolidationLeaseMs(0)).toBe(60_000);
    expect(consolidationLeaseMs(-5)).toBe(60_000);
    expect(consolidationLeaseMs(Number.NaN)).toBe(60_000);
  });

  it("is what the runtime reaches through ConsolidatorJob.leaseMsFor", () => {
    expect(ConsolidatorJob.leaseMsFor(300_000)).toBe(315_000);
  });
});
