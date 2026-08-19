import { describe, expect, it } from "vitest";

import {
  decideRoutingRole,
  ROUTING_HYSTERESIS,
} from "./decide-routing-role.js";

describe("decideRoutingRole", () => {
  it("keeps everything local at cloudShare 0, even a maximal score", () => {
    expect(
      decideRoutingRole({ score: 100, cloudShare: 0, stepIndex: 0 }),
    ).toBe("executor");
  });

  it("sends everything to the cloud at cloudShare 100, even a zero score", () => {
    expect(
      decideRoutingRole({ score: 0, cloudShare: 100, stepIndex: 9 }),
    ).toBe("orchestrator");
  });

  it("always orchestrates step 0 when the cloud leg is in play", () => {
    expect(
      decideRoutingRole({ score: 0, cloudShare: 1, stepIndex: 0 }),
    ).toBe("orchestrator");
  });

  it("routes on the cutoff at 100 - cloudShare with no prior role", () => {
    // cloudShare 40 ⇒ cutoff 60.
    expect(
      decideRoutingRole({ score: 60, cloudShare: 40, stepIndex: 1 }),
    ).toBe("orchestrator");
    expect(
      decideRoutingRole({ score: 59, cloudShare: 40, stepIndex: 1 }),
    ).toBe("executor");
  });

  it("makes it harder to leave the local leg", () => {
    // cutoff 60, previously executor ⇒ effective bar 70.
    const args = { cloudShare: 40, stepIndex: 1, previousRole: "executor" } as const;
    expect(decideRoutingRole({ ...args, score: 69 })).toBe("executor");
    expect(decideRoutingRole({ ...args, score: 70 })).toBe("orchestrator");
  });

  it("makes it harder to leave the cloud leg", () => {
    // cutoff 60, previously orchestrator ⇒ effective bar 50.
    const args = {
      cloudShare: 40,
      stepIndex: 1,
      previousRole: "orchestrator",
    } as const;
    expect(decideRoutingRole({ ...args, score: 50 })).toBe("orchestrator");
    expect(decideRoutingRole({ ...args, score: 49 })).toBe("executor");
  });

  it("applies the hysteresis symmetrically", () => {
    expect(ROUTING_HYSTERESIS).toBe(10);
    const score = 55;
    expect(
      decideRoutingRole({
        score,
        cloudShare: 40,
        stepIndex: 1,
        previousRole: "executor",
      }),
    ).toBe("executor");
    expect(
      decideRoutingRole({
        score,
        cloudShare: 40,
        stepIndex: 1,
        previousRole: "orchestrator",
      }),
    ).toBe("orchestrator");
  });

  it("treats a null previous role like no prior state", () => {
    expect(
      decideRoutingRole({
        score: 60,
        cloudShare: 40,
        stepIndex: 1,
        previousRole: null,
      }),
    ).toBe("orchestrator");
  });
});
