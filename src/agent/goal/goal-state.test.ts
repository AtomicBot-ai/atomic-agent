import { describe, expect, it } from "vitest";

import {
  GOAL_METADATA_KEY,
  createGoalState,
  goalStatusReport,
  goalSummaryLine,
  normalizeGoalSpec,
  readGoalState,
  resumeGoalState,
  sameGoalSpec,
  setGoalStatus,
  withGoalState,
} from "./goal-state.js";
import { GOAL_DEFAULT_MAX_ROUNDS, GOAL_MAX_ROUNDS_CAP } from "./goal-types.js";

describe("goal state", () => {
  it("normalizes a spec: trimmed, de-duplicated, bounded rounds", () => {
    const spec = normalizeGoalSpec({ criteria: [" a ", "a", "", "b"], checks: [" npm test ", ""] });
    expect(spec).toEqual({ criteria: ["a", "b"], checks: ["npm test"], maxRounds: GOAL_DEFAULT_MAX_ROUNDS });
    expect(normalizeGoalSpec({ criteria: ["a"], maxRounds: 999 }).maxRounds).toBe(GOAL_MAX_ROUNDS_CAP);
    expect(normalizeGoalSpec({ criteria: ["a"], maxRounds: 0 }).maxRounds).toBe(1);
    expect(() => normalizeGoalSpec({ criteria: ["  "] })).toThrow(/criterion/);
  });

  it("survives a save and load through session metadata", () => {
    const goal = setGoalStatus(createGoalState({ criteria: ["a", "b"], checks: ["make"] }, 5), "paused", 9, "paused by you");
    const metadata = withGoalState({ title: "x" }, goal);
    const reloaded = JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
    expect(readGoalState(reloaded)).toEqual(goal);
    expect(reloaded.title).toBe("x");
    expect(withGoalState(reloaded, null)[GOAL_METADATA_KEY]).toBeUndefined();
  });

  it("reads malformed metadata as no goal", () => {
    expect(readGoalState(undefined)).toBeNull();
    expect(readGoalState({ goal: "yes" })).toBeNull();
    expect(readGoalState({ goal: { version: 2, status: "active", criteria: [{ text: "a", mark: "met" }] } })).toBeNull();
    expect(readGoalState({ goal: { version: 1, status: "dreaming", criteria: [{ text: "a", mark: "met" }] } })).toBeNull();
    expect(readGoalState({ goal: { version: 1, status: "active", criteria: [] } })).toBeNull();
    expect(readGoalState({ goal: { version: 1, status: "active", criteria: [{ text: "a", mark: "maybe" }] } })).toBeNull();
    const partial = readGoalState({ goal: { version: 1, status: "active", criteria: [{ text: "a", mark: "met" }], lastVerdict: 3 } });
    expect(partial?.lastVerdict).toBeUndefined();
    expect(partial?.maxRounds).toBe(GOAL_DEFAULT_MAX_ROUNDS);
  });

  it("renders the compact goal line", () => {
    const goal = createGoalState({ criteria: ["a", "b", "c", "d", "e"] }, 0);
    const progressed = {
      ...goal,
      roundsUsed: 2,
      criteria: goal.criteria.map((c, i) => ({ ...c, mark: i < 3 ? "met" as const : "not_met" as const })),
    };
    expect(goalSummaryLine(progressed)).toBe("Goal: 3/5 criteria green · round 2/10");
    expect(goalSummaryLine(setGoalStatus(progressed, "budget_limited", 1))).toContain("round limit reached");
    expect(goalStatusReport(progressed)).toContain("[not met] d");
  });

  it("tells a resume of the same list from a new goal", () => {
    const goal = createGoalState({ criteria: ["a", "b"], checks: ["make"] }, 0);
    expect(sameGoalSpec(goal, { criteria: ["a", "b"], checks: ["make"] })).toBe(true);
    expect(sameGoalSpec(goal, { criteria: ["a"], checks: ["make"] })).toBe(false);
    expect(sameGoalSpec(goal, { criteria: ["a", "b"] })).toBe(false);
  });

  it("resumes with a fresh round budget only after the budget ran out", () => {
    const used = { ...createGoalState({ criteria: ["a"] }, 0), roundsUsed: 10, judgeFailures: 3 };
    const fromBudget = resumeGoalState(setGoalStatus(used, "budget_limited", 1, "out"), 2);
    expect(fromBudget).toMatchObject({ status: "active", roundsUsed: 0, judgeFailures: 0 });
    expect(fromBudget.statusReason).toBeUndefined();
    const fromPause = resumeGoalState(setGoalStatus({ ...used, roundsUsed: 4 }, "paused", 1), 2);
    expect(fromPause).toMatchObject({ status: "active", roundsUsed: 4, judgeFailures: 0 });
  });

  it("gives a fresh round budget to a goal stopped on its last round", () => {
    const used = { ...createGoalState({ criteria: ["a"] }, 0), roundsUsed: 10 };
    expect(resumeGoalState(setGoalStatus(used, "paused", 1, "judge"), 2).roundsUsed).toBe(0);
    expect(resumeGoalState(setGoalStatus(used, "blocked", 1, "needs you"), 2).roundsUsed).toBe(0);
    // Left active at the limit by a crash after the round was counted.
    expect(resumeGoalState(used, 2).roundsUsed).toBe(0);
  });
});
