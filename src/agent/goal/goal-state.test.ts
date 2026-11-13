import { describe, expect, it } from "vitest";

import {
  GOAL_METADATA_KEY,
  createGoalState,
  goalSpecOf,
  goalStatusReport,
  goalSummaryLine,
  isInterruptedGoal,
  normalizeGoalSpec,
  readGoalState,
  resumeGoalState,
  sameGoalSpec,
  setGoalStatus,
  withGoalState,
} from "./goal-state.js";
import { GOAL_DEFAULT_MAX_ROUNDS, GOAL_MAX_ROUNDS_CAP, type GoalState } from "./goal-types.js";

describe("goal state", () => {
  it("normalizes a spec: trimmed, de-duplicated, bounded rounds", () => {
    const spec = normalizeGoalSpec({ criteria: [" a ", "a", "", "b"], checks: [" npm test ", ""] });
    expect(spec).toEqual({ criteria: ["a", "b"], checks: ["npm test"], maxRounds: GOAL_DEFAULT_MAX_ROUNDS, maxTokens: 0 });
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
    expect(goalSummaryLine(setGoalStatus(progressed, "budget_limited", 1))).toContain("budget reached");
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

  it("bounds a token budget: 0, negative or junk means no cap (ATO-1036)", () => {
    expect(normalizeGoalSpec({ criteria: ["a"], maxTokens: 250_000.7 }).maxTokens).toBe(250_000);
    expect(normalizeGoalSpec({ criteria: ["a"], maxTokens: -5 }).maxTokens).toBe(0);
    expect(normalizeGoalSpec({ criteria: ["a"], maxTokens: Number.NaN }).maxTokens).toBe(0);
    const capped = createGoalState({ criteria: ["a"], maxTokens: 1_000 }, 0);
    expect(capped).toMatchObject({ maxTokens: 1_000, tokensUsed: 0 });
    expect(goalSpecOf(capped).maxTokens).toBe(1_000);
    expect(goalSpecOf(createGoalState({ criteria: ["a"] }, 0))).not.toHaveProperty("maxTokens");
  });

  it("reads a goal saved before the token budget as uncapped with nothing used", () => {
    const old = readGoalState({ goal: { version: 1, status: "paused", criteria: [{ text: "a", mark: "met" }], roundsUsed: 3 } });
    expect(old).toMatchObject({ maxTokens: 0, tokensUsed: 0, roundsUsed: 3 });
    expect(old?.owner).toBeUndefined();
  });

  it("shows the token budget on the goal line", () => {
    const goal = { ...createGoalState({ criteria: ["a"], maxTokens: 2_000_000 }, 0), tokensUsed: 12_345 };
    expect(goalSummaryLine(goal)).toBe("Goal: 0/1 criteria green · round 0/10 · tokens 12.3k/2.0M");
  });

  it("starts a spent token budget over on resume, keeps a partial one", () => {
    const spent = { ...createGoalState({ criteria: ["a"], maxTokens: 100 }, 0), tokensUsed: 150 };
    expect(resumeGoalState(setGoalStatus(spent, "budget_limited", 1, "tokens"), 2).tokensUsed).toBe(0);
    expect(resumeGoalState(setGoalStatus(spent, "paused", 1), 2).tokensUsed).toBe(0);
    const partial = { ...spent, tokensUsed: 40 };
    expect(resumeGoalState(setGoalStatus(partial, "paused", 1), 2).tokensUsed).toBe(40);
  });

  it("marks an active goal stored by another process as interrupted (ATO-1038)", () => {
    const mine = createGoalState({ criteria: ["a"] }, 0);
    expect(isInterruptedGoal(mine)).toBe(false);
    // What a restart leaves: the JSON of an active goal stamped by the old process.
    const stored = readGoalState(JSON.parse(JSON.stringify(withGoalState({}, { ...mine, owner: "old-process" }))))!;
    expect(stored.status).toBe("active");
    expect(isInterruptedGoal(stored)).toBe(true);
    expect(goalSummaryLine(stored)).toContain("interrupted, /goal resume continues");
    expect(goalStatusReport(stored)).toContain("/goal resume continues it");
    // A goal saved before the stamp existed reads the same way.
    const unstamped: GoalState = { ...mine };
    delete unstamped.owner;
    expect(isInterruptedGoal(unstamped)).toBe(true);
    // Only an active goal can be interrupted; the explicit resume claims it.
    expect(isInterruptedGoal(setGoalStatus(stored, "paused", 1))).toBe(false);
    expect(isInterruptedGoal(resumeGoalState(stored, 2))).toBe(false);
  });
});
