import { describe, expect, it } from "vitest";

import { compressToolResult } from "../../compressor/result-compressor.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { normalizeSessionState } from "../../session/normalize-session-state.js";
import { applyStateEffects } from "./step-commit.js";

const planResult = (items: unknown[], status: "ok" | "error" = "ok") =>
  compressToolResult({
    tool: "plan.update",
    status,
    output: "plan",
    details: { planSnapshot: { items, updatedAt: 5 } },
  });

describe("live plan state effect (ATO-486)", () => {
  const session = createEmptySessionState({ id: "s", workingDir: "/tmp" });

  it("stores the newest snapshot on the session", () => {
    const first = applyStateEffects(session, planResult([{ step: "a", status: "in_progress" }]));
    const second = applyStateEffects(first, planResult([{ step: "a", status: "done" }, { step: "b", status: "pending" }]));
    expect(second.plan).toEqual({
      items: [{ step: "a", status: "done" }, { step: "b", status: "pending" }],
      updatedAt: 5,
    });
  });

  it("clears the plan on an empty list", () => {
    const withPlan = applyStateEffects(session, planResult([{ step: "a", status: "pending" }]));
    const cleared = applyStateEffects(withPlan, planResult([]));
    expect(cleared.plan).toBeUndefined();
    expect("plan" in cleared).toBe(false);
  });

  it("ignores an errored call", () => {
    const withPlan = applyStateEffects(session, planResult([{ step: "a", status: "pending" }]));
    const after = applyStateEffects(withPlan, planResult([{ step: "b", status: "pending" }], "error"));
    expect(after.plan?.items).toEqual([{ step: "a", status: "pending" }]);
  });

  it("survives the store round trip and drops a broken stored plan", () => {
    const withPlan = applyStateEffects(session, planResult([{ step: "a", status: "done" }]));
    const reloaded = normalizeSessionState(JSON.parse(JSON.stringify(withPlan)));
    expect(reloaded.plan).toEqual(withPlan.plan);
    const broken = normalizeSessionState({ ...JSON.parse(JSON.stringify(withPlan)), plan: { items: 3 } });
    expect(broken.plan).toBeUndefined();
  });
});
