import { describe, expect, it, vi } from "vitest";

import {
  createGoalState,
  readGoalState,
  setGoalStatus,
  withGoalState,
  type GoalState,
} from "../../agent/goal/index.js";
import { createEmptySessionState, type SessionState } from "../../session/index.js";
import {
  activeGoalSpec,
  createGoalProgressReporter,
  runGoalCommand,
  type GoalCommandContext,
} from "./goal-commands.js";

function context(session: SessionState, overrides: Partial<GoalCommandContext> = {}) {
  const saved: SessionState[] = [];
  const sent: string[] = [];
  const said: string[] = [];
  const shown: (GoalState | null)[] = [];
  const ctx: GoalCommandContext = {
    session,
    turnRunning: false,
    save: (next) => { saved.push(next); },
    send: (text) => { sent.push(text); },
    say: (text) => { said.push(text); },
    show: (goal) => { shown.push(goal); },
    now: () => 100,
    ...overrides,
  };
  return { ctx, saved, sent, said, shown };
}

const empty = createEmptySessionState({ id: "s1", workingDir: "/w" });
function withGoal(goal: GoalState): SessionState {
  return { ...empty, metadata: withGoalState(empty.metadata, goal) };
}

describe("runGoalCommand", () => {
  it("sets a goal, stores it with the session and sends the kickoff", () => {
    const t = context(empty);
    runGoalCommand({ kind: "set", criteria: ["tests pass", "README updated"], checks: ["npm test"] }, t.ctx);
    const stored = readGoalState(t.saved[0]!.metadata);
    expect(stored).toMatchObject({ status: "active", checks: ["npm test"], roundsUsed: 0 });
    expect(stored?.criteria.map((c) => c.text)).toEqual(["tests pass", "README updated"]);
    expect(t.sent[0]).toContain("1. tests pass");
    expect(t.sent[0]).toContain("`npm test`");
    expect(t.shown[0]?.status).toBe("active");
  });

  it("refuses to set a goal while a turn runs", () => {
    const t = context(empty, { turnRunning: true });
    runGoalCommand({ kind: "set", criteria: ["a"], checks: [] }, t.ctx);
    expect(t.saved).toHaveLength(0);
    expect(t.sent).toHaveLength(0);
  });

  it("adds a check only to an existing goal", () => {
    const none = context(empty);
    runGoalCommand({ kind: "check_add", command: "npm test" }, none.ctx);
    expect(none.saved).toHaveLength(0);
    expect(none.said[0]).toMatch(/set a goal first/);

    const t = context(withGoal(setGoalStatus(createGoalState({ criteria: ["a"] }, 0), "paused", 1)));
    runGoalCommand({ kind: "check_add", command: "npm test" }, t.ctx);
    expect(readGoalState(t.saved[0]!.metadata)?.checks).toEqual(["npm test"]);
  });

  it("pauses a running goal through the runtime, an idle one in the store", () => {
    const active = withGoal(createGoalState({ criteria: ["a"] }, 0));
    const controlGoal = vi.fn(() => true);
    const running = context(active, { turnRunning: true, controlGoal });
    runGoalCommand({ kind: "pause" }, running.ctx);
    expect(controlGoal).toHaveBeenCalledWith("s1", "pause");
    expect(running.saved).toHaveLength(0);

    const idle = context(active);
    runGoalCommand({ kind: "pause" }, idle.ctx);
    expect(readGoalState(idle.saved[0]!.metadata)?.status).toBe("paused");
  });

  it("resumes a stopped goal and continues from where it was", () => {
    const stopped = setGoalStatus(
      { ...createGoalState({ criteria: ["a", "b"] }, 0), roundsUsed: 10 },
      "budget_limited", 1, "used all 10 rounds",
    );
    const t = context(withGoal(stopped));
    runGoalCommand({ kind: "resume" }, t.ctx);
    expect(readGoalState(t.saved[0]!.metadata)).toMatchObject({ status: "active", roundsUsed: 0 });
    expect(t.sent).toHaveLength(1);
  });

  it("clears the stored goal", () => {
    const t = context(withGoal(createGoalState({ criteria: ["a"] }, 0)));
    runGoalCommand({ kind: "clear" }, t.ctx);
    expect(readGoalState(t.saved[0]!.metadata)).toBeNull();
    expect(t.shown).toEqual([null]);
  });

  it("reports the status", () => {
    const t = context(withGoal(createGoalState({ criteria: ["a"] }, 0)));
    runGoalCommand({ kind: "status" }, t.ctx);
    expect(t.said[0]).toContain("Goal: 0/1 criteria green · round 0/10");
  });
});

describe("activeGoalSpec", () => {
  it("drives rounds only while the goal is active", () => {
    const goal = createGoalState({ criteria: ["a"], checks: ["make"] }, 0);
    expect(activeGoalSpec(withGoal(goal))).toEqual({ criteria: ["a"], checks: ["make"], maxRounds: 10 });
    expect(activeGoalSpec(withGoal(setGoalStatus(goal, "paused", 1)))).toBeUndefined();
    expect(activeGoalSpec(empty)).toBeUndefined();
  });

  it("does not let a goal a restart cut off drive the next message (ATO-1038)", () => {
    const goal = createGoalState({ criteria: ["a"] }, 0);
    // An active goal as the old process left it in the store.
    const cutOff = withGoal({ ...goal, owner: "a-process-that-is-gone" });
    expect(activeGoalSpec(cutOff)).toBeUndefined();

    // `/goal resume` is the explicit go-on: it claims the goal and sends.
    const t = context(cutOff);
    runGoalCommand({ kind: "resume" }, t.ctx);
    const resumed = { ...cutOff, metadata: t.saved[0]!.metadata };
    expect(activeGoalSpec(resumed)).toEqual({ criteria: ["a"], checks: [], maxRounds: 10 });
    expect(t.sent).toHaveLength(1);
  });
});

describe("/goal tokens", () => {
  it("sets and removes the token budget of a stored goal", () => {
    const paused = setGoalStatus(createGoalState({ criteria: ["a"] }, 0), "paused", 1);
    const t = context(withGoal(paused));
    runGoalCommand({ kind: "tokens", maxTokens: 500_000 }, t.ctx);
    expect(readGoalState(t.saved[0]!.metadata)?.maxTokens).toBe(500_000);
    expect(t.said[0]).toContain("500000 tokens");

    const off = context(withGoal({ ...paused, maxTokens: 10 }));
    runGoalCommand({ kind: "tokens", maxTokens: 0 }, off.ctx);
    expect(readGoalState(off.saved[0]!.metadata)?.maxTokens).toBe(0);
  });

  it("needs a goal and refuses while the goal is running", () => {
    const none = context(empty);
    runGoalCommand({ kind: "tokens", maxTokens: 10 }, none.ctx);
    expect(none.saved).toHaveLength(0);

    const running = context(withGoal(createGoalState({ criteria: ["a"] }, 0)), { turnRunning: true });
    runGoalCommand({ kind: "tokens", maxTokens: 10 }, running.ctx);
    expect(running.saved).toHaveLength(0);
    expect(running.said[0]).toMatch(/goal pause/);
  });
});

describe("createGoalProgressReporter", () => {
  it("says one line per evaluation and one when the goal stops", () => {
    const said: string[] = [];
    const report = createGoalProgressReporter((t) => said.push(t), () => {});
    const goal = { ...createGoalState({ criteria: ["a"] }, 0), roundsUsed: 1 };
    report(goal);
    const judged = { ...goal, lastVerdict: { at: 5, round: 1, summary: "0/1 criteria met", checks: [] } };
    report(judged);
    report(judged);
    report(setGoalStatus(judged, "complete", 6, "every item on the acceptance list is met"));
    expect(said).toEqual([
      "goal round 1: 0/1 criteria met",
      expect.stringContaining("complete"),
    ]);
  });
});
