import { describe, expect, it } from "vitest";

import { StepRouter, type FusionRoutingSnapshot } from "./step-router.js";

const FUSION: FusionRoutingSnapshot = {
  cloudProviderId: "openrouter",
  localProviderId: "local-llama",
  cloudShare: 40,
  subRunners: "local",
  maxSteps: 25,
  conversationMaxTokens: 32_000,
};

function router(snapshot: FusionRoutingSnapshot | null = FUSION): StepRouter {
  return new StepRouter({ resolveFusion: () => snapshot });
}

/**
 * Scores 55 with the FUSION snapshot: above the cutoff a prior cloud
 * step lowers it to (50), below the bare cutoff (60). That band is
 * exactly where hysteresis is observable.
 */
const MEDIUM = { promptTokens: 24_000, stablePrefixTokens: 4_000, stepIndex: 10 };
/** Scores 68: above the bare cutoff, below the "came from local" bar (70). */
const HEAVY = { promptTokens: 30_000, stablePrefixTokens: 4_000, stepIndex: 15 };

const step = (over: Partial<Parameters<StepRouter["routeStep"]>[0]> = {}) => ({
  sessionId: "s1",
  stepIndex: 1,
  promptTokens: 1_000,
  stablePrefixTokens: 900,
  hasTransientNotice: false,
  ...over,
});

describe("StepRouter", () => {
  it("returns null when fusion is not the effective mode", () => {
    expect(router(null).routeStep(step())).toBeNull();
  });

  it("routes step 0 to the cloud orchestrator", () => {
    const routing = router().routeStep(step({ stepIndex: 0 }));
    expect(routing).toMatchObject({
      role: "orchestrator",
      providerId: "openrouter",
      cloudShare: 40,
    });
  });

  it("routes a cheap continuation step to the local executor", () => {
    const routing = router().routeStep(step());
    expect(routing).toMatchObject({
      role: "executor",
      providerId: "local-llama",
    });
  });

  it("escalates a heavy continuation step to the cloud", () => {
    const routing = router().routeStep(
      step({
        stepIndex: 20,
        promptTokens: 30_000,
        stablePrefixTokens: 4_000,
        hasTransientNotice: true,
      }),
    );
    expect(routing?.role).toBe("orchestrator");
    expect(routing?.complexity).toBeGreaterThanOrEqual(60);
  });

  it("re-reads the live snapshot on every step", () => {
    let snapshot: FusionRoutingSnapshot = { ...FUSION, cloudShare: 0 };
    const r = new StepRouter({ resolveFusion: () => snapshot });
    expect(r.routeStep(step({ stepIndex: 0 }))?.role).toBe("executor");
    snapshot = { ...FUSION, cloudShare: 100 };
    expect(r.routeStep(step({ stepIndex: 1 }))?.role).toBe("orchestrator");
  });

  it("keeps hysteresis state per session", () => {
    const r = router();
    // Drive session A to the cloud (step 0 always orchestrates) and
    // session B to local (a cheap continuation step).
    expect(r.routeStep(step({ sessionId: "a", stepIndex: 0 }))?.role).toBe(
      "orchestrator",
    );
    expect(r.routeStep(step({ sessionId: "b", stepIndex: 1 }))?.role).toBe(
      "executor",
    );
    // Identical score, opposite prior roles ⇒ opposite decisions.
    const a = r.routeStep(step({ sessionId: "a", ...HEAVY }));
    const b = r.routeStep(step({ sessionId: "b", ...HEAVY }));
    expect(a?.complexity).toBe(b?.complexity);
    expect(a?.role).toBe("orchestrator");
    expect(b?.role).toBe("executor");
  });

  it("forgets a session on request", () => {
    const r = router();
    // Same MEDIUM step decided twice: sticky to the cloud while the
    // prior role survives, back to the bare cutoff once it is dropped.
    r.routeStep(step({ sessionId: "a", stepIndex: 0 }));
    expect(r.routeStep(step({ sessionId: "a", ...MEDIUM }))?.role).toBe(
      "orchestrator",
    );
    r.forgetSession("a");
    expect(r.routeStep(step({ sessionId: "a", ...MEDIUM }))?.role).toBe(
      "executor",
    );
  });

  it("drops hysteresis state when fusion is switched off", () => {
    let snapshot: FusionRoutingSnapshot | null = FUSION;
    const r = new StepRouter({ resolveFusion: () => snapshot });
    r.routeStep(step({ stepIndex: 0 }));
    snapshot = null;
    expect(r.routeStep(step())).toBeNull();
    snapshot = FUSION;
    // The prior cloud role is gone, so the bare cutoff applies again.
    expect(r.routeStep(step({ ...MEDIUM }))?.role).toBe("executor");
  });

  it("sends sub-runners to the local leg by default", () => {
    expect(router().subRunnerProviderId("s1")).toBe("local-llama");
  });

  it("sends sub-runners to the cloud when configured", () => {
    expect(
      router({ ...FUSION, subRunners: "cloud" }).subRunnerProviderId("s1"),
    ).toBe("openrouter");
  });

  it("follows the session's last main-loop leg when configured", () => {
    const r = router({ ...FUSION, subRunners: "follow" });
    r.routeStep(step({ sessionId: "s1", stepIndex: 0 }));
    expect(r.subRunnerProviderId("s1")).toBe("openrouter");
    r.forgetSession("s1");
    expect(r.subRunnerProviderId("s1")).toBe("local-llama");
  });

  it("has no sub-runner opinion outside fusion", () => {
    expect(router(null).subRunnerProviderId("s1")).toBeNull();
  });
});
