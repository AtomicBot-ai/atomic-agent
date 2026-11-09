import { describe, expect, it, vi } from "vitest";

import type { RunTurnResult } from "../agent-contract.js";
import { createEmptySessionState, type SessionState } from "../../session/session-state.js";
import { runGoal, type GoalControllerDeps } from "./goal-controller.js";
import { createGoalState, readGoalState } from "./goal-state.js";
import type { GoalCheckResult, GoalState } from "./goal-types.js";

function replied(session: SessionState, text: string): RunTurnResult {
  return {
    session: {
      ...session,
      turns: [
        ...session.turns,
        { kind: "assistant_reply", text, at: 1 },
      ],
    },
    reason: "reply",
    stepCount: 3,
  };
}

function verdict(...marks: string[]): string {
  return JSON.stringify({
    criteria: marks.map((m, i) => ({ index: i + 1, verdict: m, reason: `reason ${i + 1}` })),
  });
}

interface Harness {
  deps: GoalControllerDeps;
  messages: string[];
  saved: GoalState[];
}

function harness(overrides: Partial<GoalControllerDeps> & {
  judgeAnswers?: (string | Error)[];
  checkResults?: GoalCheckResult[][];
}): Harness {
  const messages: string[] = [];
  const saved: GoalState[] = [];
  const answers = [...(overrides.judgeAnswers ?? [])];
  const checks = [...(overrides.checkResults ?? [])];
  let clock = 1_000;
  const deps: GoalControllerDeps = {
    runRound: async (session, message) => {
      messages.push(message);
      return replied(session, `done round ${messages.length}`);
    },
    runChecks: async () => checks.shift() ?? [],
    judge: async () => {
      const next = answers.shift();
      if (next === undefined) throw new Error("no judge answer scripted");
      if (next instanceof Error) throw next;
      return next;
    },
    saveGoal: (_id, state) => { saved.push(state); },
    now: () => (clock += 10),
    ...overrides,
  };
  return { deps, messages, saved };
}

const session = createEmptySessionState({ id: "s1", workingDir: "/work" });
const signal = new AbortController().signal;

function goal(criteria: string[], extra: { checks?: string[]; maxRounds?: number } = {}): GoalState {
  return createGoalState({ criteria, ...extra }, 0);
}

describe("runGoal", () => {
  it("feeds a failing check's output into the next round and skips the judge", async () => {
    const judge = vi.fn(async () => verdict("met"));
    const h = harness({
      judge,
      checkResults: [
        [{ command: "npm test", passed: false, exitCode: 1, timedOut: false, output: "FAIL src/a.test.ts\nexpected 2" }],
        [{ command: "npm test", passed: true, exitCode: 0, timedOut: false, output: "ok" }],
      ],
    });
    const out = await runGoal(h.deps, {
      session, message: "start", goal: goal(["tests pass"], { checks: ["npm test"] }), signal,
    });
    expect(h.messages).toHaveLength(2);
    expect(h.messages[1]).toContain("npm test");
    expect(h.messages[1]).toContain("FAIL src/a.test.ts");
    expect(h.messages[1]).toContain("exit 1");
    expect(judge).toHaveBeenCalledTimes(1);
    expect(out.goal?.status).toBe("complete");
    expect(out.goal?.roundsUsed).toBe(2);
  });

  it("completes when the judge marks every criterion met", async () => {
    const h = harness({ judgeAnswers: [verdict("met", "met")] });
    const out = await runGoal(h.deps, { session, message: "start", goal: goal(["a", "b"]), signal });
    expect(out.goal?.status).toBe("complete");
    expect(out.goal?.criteria.map((c) => c.mark)).toEqual(["met", "met"]);
    expect(out.result.goal?.status).toBe("complete");
    // The returned session carries the goal as it was saved last.
    expect(readGoalState(out.result.session.metadata)?.status).toBe("complete");
  });

  it("starts the next round with the open criteria and the judge's reasons", async () => {
    const h = harness({ judgeAnswers: [verdict("met", "not_met"), verdict("met", "met")] });
    const out = await runGoal(h.deps, { session, message: "start", goal: goal(["a", "b"]), signal });
    expect(h.messages).toHaveLength(2);
    expect(h.messages[1]).toContain("2. b: reason 2");
    expect(h.messages[1]).not.toContain("1. a");
    expect(out.goal?.status).toBe("complete");
  });

  it("stops as blocked and says what the person must provide", async () => {
    const h = harness({ judgeAnswers: [verdict("met", "blocked")] });
    const out = await runGoal(h.deps, { session, message: "start", goal: goal(["a", "deploy"]), signal });
    expect(h.messages).toHaveLength(1);
    expect(out.goal?.status).toBe("blocked");
    expect(out.goal?.statusReason).toContain("deploy: reason 2");
  });

  it("pauses after three unreadable judge replies instead of looping", async () => {
    const runRound = vi.fn(async (s: SessionState) => replied(s, "did it"));
    const h = harness({ runRound, judgeAnswers: ["sure, looks good", "{}", "```json\n{not json}\n```"] });
    const out = await runGoal(h.deps, { session, message: "start", goal: goal(["a"]), signal });
    expect(runRound).toHaveBeenCalledTimes(1);
    expect(out.goal?.status).toBe("paused");
    expect(out.goal?.judgeFailures).toBe(3);
    expect(out.goal?.statusReason).toContain("3 times");
  });

  it("counts judge errors like unreadable replies", async () => {
    const h = harness({ judgeAnswers: [new Error("503"), new Error("503"), new Error("503")] });
    const out = await runGoal(h.deps, { session, message: "start", goal: goal(["a"]), signal });
    expect(out.goal?.status).toBe("paused");
    expect(out.goal?.statusReason).toContain("503");
  });

  it("recovers when a retry of the judge reads", async () => {
    const h = harness({ judgeAnswers: ["nope", verdict("met")] });
    const out = await runGoal(h.deps, { session, message: "start", goal: goal(["a"]), signal });
    expect(out.goal?.status).toBe("complete");
    expect(out.goal?.judgeFailures).toBe(0);
  });

  it("stops as budget_limited when the round limit is used up", async () => {
    const h = harness({ judgeAnswers: Array(5).fill(verdict("not_met")) });
    const out = await runGoal(h.deps, {
      session, message: "start", goal: goal(["a"], { maxRounds: 3 }), signal,
    });
    expect(h.messages).toHaveLength(3);
    expect(out.goal?.status).toBe("budget_limited");
    expect(out.goal?.roundsUsed).toBe(3);
  });

  it("treats a round that hit a ceiling as budget_limited without judging", async () => {
    const judge = vi.fn(async () => verdict("met"));
    const h = harness({
      judge,
      runRound: async (s) => ({ ...replied(s, "ran out"), stopCause: "time_ceiling" }),
    });
    const out = await runGoal(h.deps, { session, message: "start", goal: goal(["a"]), signal });
    expect(judge).not.toHaveBeenCalled();
    expect(out.goal?.status).toBe("budget_limited");
  });

  it("pauses on a stopped or failed round", async () => {
    for (const reason of ["cancelled", "failed"] as const) {
      const h = harness({ runRound: async (s) => ({ session: s, reason, stepCount: 1 }) });
      const out = await runGoal(h.deps, { session, message: "start", goal: goal(["a"]), signal });
      expect(out.goal?.status).toBe("paused");
    }
  });

  it("passes the remaining time to each round and stops when it is gone", async () => {
    const budgets: (number | undefined)[] = [];
    let clock = 0;
    const h = harness({
      now: () => clock,
      runRound: async (s, _m, options) => {
        budgets.push(options.taskMaxDurationMs);
        clock += 600;
        return replied(s, "worked");
      },
      judgeAnswers: Array(5).fill(verdict("not_met")),
    });
    const out = await runGoal(h.deps, {
      session, message: "start", goal: goal(["a"]), signal, taskMaxDurationMs: 1_000,
    });
    expect(budgets).toEqual([1_000, 400]);
    expect(out.goal?.status).toBe("budget_limited");
  });

  it("honours a pause or clear requested between rounds", async () => {
    const controls: ("pause" | "clear" | null)[] = [null, "pause"];
    const h = harness({
      judgeAnswers: [verdict("not_met")],
      pendingControl: () => controls.shift() ?? null,
    });
    const paused = await runGoal(h.deps, { session, message: "start", goal: goal(["a"]), signal });
    expect(h.messages).toHaveLength(1);
    expect(paused.goal?.status).toBe("paused");

    const cleared = await runGoal(
      harness({ pendingControl: () => "clear" }).deps,
      { session, message: "start", goal: goal(["a"]), signal },
    );
    expect(cleared.goal).toBeNull();
    expect(readGoalState(cleared.result.session.metadata)).toBeNull();
  });

  it("saves the goal after every change so a restart resumes it", async () => {
    const h = harness({ judgeAnswers: [verdict("not_met"), verdict("met")] });
    await runGoal(h.deps, { session, message: "start", goal: goal(["a"]), signal });
    const rounds = h.saved.map((s) => s.roundsUsed);
    expect(rounds[0]).toBe(1);
    expect(Math.max(...rounds)).toBe(2);
    const last = h.saved.at(-1)!;
    expect(last.status).toBe("complete");
    expect(last.lastVerdict?.summary).toBe("1/1 criteria met");
    // What the store holds survives a JSON round trip unchanged.
    expect(readGoalState({ goal: JSON.parse(JSON.stringify(last)) })).toEqual(last);
  });

  it("stops when the agent closed the session before the goal was met", async () => {
    const rounds: string[] = [];
    const h = harness({
      runRound: async (s, message) => {
        rounds.push(message);
        return { ...replied(s, "bye"), reason: "finish" };
      },
      judgeAnswers: [verdict("not_met")],
    });
    const out = await runGoal(h.deps, { session, message: "start", goal: goal(["a"]), signal });
    expect(rounds).toHaveLength(1);
    expect(out.goal?.status).toBe("paused");
  });
});
