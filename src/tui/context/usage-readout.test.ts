import { describe, expect, it } from "vitest";
import { EMPTY_SESSION_USAGE } from "../../session/usage-meter.js";
import { usageReadoutLabel, usageReadoutUrgent } from "./usage-readout.js";

const NOW = new Date(2026, 10, 6, 12, 0).getTime();
const limit = (usedPercent: number) => ({
  scope: "subscription" as const,
  name: "5h",
  usedPercent,
  resetsAt: new Date(2026, 10, 6, 15, 0).getTime(),
  providerId: "codex",
  modelId: null,
  observedAt: NOW,
});

describe("usageReadoutLabel (ATO-569)", () => {
  it("takes no columns before the session has made a call", () => {
    expect(usageReadoutLabel(null, NOW)).toBeNull();
    expect(usageReadoutLabel(EMPTY_SESSION_USAGE, NOW)).toBeNull();
  });

  it("reads like the status bar: cost, then the plan window", () => {
    expect(
      usageReadoutLabel(
        { ...EMPTY_SESSION_USAGE, costUsd: 0.31, pricedCalls: 2, limits: [limit(83)] },
        NOW,
      ),
    ).toBe(" · $0.31 · 17% left, resets 15:00 ");
  });

  it("turns urgent only when the plan window is nearly spent", () => {
    expect(usageReadoutUrgent({ ...EMPTY_SESSION_USAGE, limits: [limit(83)] }, NOW)).toBe(false);
    expect(usageReadoutUrgent({ ...EMPTY_SESSION_USAGE, limits: [limit(95)] }, NOW)).toBe(true);
    expect(usageReadoutUrgent({ ...EMPTY_SESSION_USAGE, costUsd: 50, pricedCalls: 9 }, NOW)).toBe(false);
  });
});
