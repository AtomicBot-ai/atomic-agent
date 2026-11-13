import { describe, expect, it } from "vitest";

import { createGoalState, resumeGoalState, setGoalStatus, withGoalState } from "../agent/goal/index.js";
import { createEmptySessionState } from "../session/index.js";

import { chatGoalSpec, goalProgressFrame } from "./chat-goal.js";

const goal = createGoalState({ criteria: ["tests pass"], checks: ["npm test"], maxRounds: 4 }, 1);
const sessionWith = (state: typeof goal | null) =>
  createEmptySessionState({ id: "s1", workingDir: "/tmp", metadata: withGoalState({}, state) });

describe("chatGoalSpec", () => {
  it("runs an active stored goal, with its own checks and round limit, for an extensions client", () => {
    expect(chatGoalSpec(sessionWith(goal), true)).toEqual({
      criteria: ["tests pass"], checks: ["npm test"], maxRounds: 4,
    });
  });

  it("leaves a plain OpenAI client, a chat without a goal and a stopped goal alone", () => {
    expect(chatGoalSpec(sessionWith(goal), false)).toBeUndefined();
    expect(chatGoalSpec(sessionWith(null), true)).toBeUndefined();
    for (const status of ["paused", "blocked", "complete", "budget_limited"] as const) {
      expect(chatGoalSpec(sessionWith(setGoalStatus(goal, status, 2)), true)).toBeUndefined();
    }
  });
});

describe("chatGoalSpec after a restart (ATO-1038)", () => {
  it("does not run an active goal another agent process left behind", () => {
    // What the store holds after a restart: active, stamped by the old process.
    const leftBehind = { ...goal, status: "active" as const, owner: "other-process" };
    expect(chatGoalSpec(sessionWith(leftBehind), true)).toBeUndefined();
  });

  it("runs it again once resumed, which claims it for this process", () => {
    const leftBehind = { ...goal, owner: "other-process" };
    expect(chatGoalSpec(sessionWith(resumeGoalState(leftBehind, 3)), true)).toEqual({
      criteria: ["tests pass"], checks: ["npm test"], maxRounds: 4,
    });
  });
});

describe("goalProgressFrame", () => {
  it("carries the whole goal state under its object name", () => {
    expect(goalProgressFrame("s1", goal)).toEqual({ object: "atomic.goal_progress", session_id: "s1", goal });
  });
});
