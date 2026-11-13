import { describe, expect, it } from "vitest";

import { goalIdeaInputs } from "./idea-goal-source.js";
import {
  RETRY_TASK_LOOKBACK_MS,
  buildIdeaCandidates,
  resumeGoalIdeas,
  retryTaskIdeas,
  type GoalIdeaInput,
} from "./idea-rules.js";
import { IDEAS_PER_KIND_MAX } from "./idea-types.js";
import type { TaskRecord } from "./task-types.js";

const NOW = 1_800_000_000_000;

function task(overrides: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    sessionId: "s-1",
    userMessage: "build the report",
    maxSteps: null,
    status: "failed",
    origin: "cli",
    attempts: 1,
    maxAttempts: 1,
    lastError: "provider timed out",
    lastErrorCategory: "transport",
    createdAt: NOW - 10_000,
    updatedAt: NOW - 5_000,
    startedAt: NOW - 9_000,
    completedAt: NOW - 5_000,
    schedule: null,
    scheduledFor: null,
    recurring: false,
    lastScheduledAt: null,
    triggerSource: "user",
    notify: null,
    maxCostUsd: null,
    maxDurationMs: null,
    spentUsd: null,
    elapsedMs: null,
    stopCause: null,
    ...overrides,
  };
}

function goal(overrides: Partial<GoalIdeaInput> = {}): GoalIdeaInput {
  return {
    sessionId: "s-goal",
    status: "paused",
    statusReason: "Paused by you.",
    openCriteria: ["tests pass", "README updated"],
    goalCreatedAt: NOW - 100_000,
    updatedAt: NOW - 1_000,
    ...overrides,
  };
}

describe("retryTaskIdeas", () => {
  it("suggests a recent failed or blocked task with its error as evidence", () => {
    const ideas = retryTaskIdeas(
      [task({ id: "a" }), task({ id: "b", status: "blocked", userMessage: "other", lastError: "session missing" })],
      NOW,
    );
    expect(ideas).toHaveLength(2);
    expect(ideas.find((i) => i.sourceKey === "task:a")).toMatchObject({
      kind: "retry_task",
      title: "Retry: build the report",
      reason: "This task failed and has not been run again.",
      evidence: { source: "task", ref: "a", excerpt: "provider timed out", at: NOW - 5_000 },
      prompt: "build the report",
      sessionId: null,
    });
    expect(ideas.find((i) => i.sourceKey === "task:b")?.reason).toContain("was blocked");
  });

  it("skips cancelled, completed, pending and old tasks", () => {
    const ideas = retryTaskIdeas(
      [
        task({ id: "c", status: "cancelled", userMessage: "m1" }),
        task({ id: "d", status: "completed", userMessage: "m2" }),
        task({ id: "e", status: "pending", userMessage: "m3" }),
        task({ id: "f", userMessage: "m4", completedAt: NOW - RETRY_TASK_LOOKBACK_MS - 1 }),
      ],
      NOW,
    );
    expect(ideas).toEqual([]);
  });

  it("does not suggest a task that was already run again with the same message", () => {
    const ideas = retryTaskIdeas(
      [
        task({ id: "old", userMessage: "Build  the report" }),
        task({ id: "new", status: "completed", userMessage: "build the report", createdAt: NOW - 1_000 }),
      ],
      NOW,
    );
    expect(ideas).toEqual([]);
  });

  it("offers every qualifying task, newest first (the store applies the cap)", () => {
    const tasks = Array.from({ length: IDEAS_PER_KIND_MAX + 3 }, (_, i) =>
      task({ id: `t${i}`, userMessage: `job ${i}`, completedAt: NOW - 1_000 * (i + 1) }),
    );
    const ideas = retryTaskIdeas(tasks, NOW);
    expect(ideas).toHaveLength(IDEAS_PER_KIND_MAX + 3);
    expect(ideas.map((i) => i.sourceKey)).toEqual(tasks.map((t) => `task:${t.id}`));
  });
});

describe("resumeGoalIdeas", () => {
  it("suggests a paused goal with open items, running in its own chat", () => {
    const [idea] = resumeGoalIdeas([goal()], NOW);
    expect(idea).toMatchObject({
      kind: "resume_goal",
      sourceKey: `goal:s-goal:${NOW - 100_000}`,
      title: "Finish the goal: tests pass",
      sessionId: "s-goal",
      evidence: { source: "goal", ref: "s-goal", excerpt: "Paused by you. Still open: tests pass; README updated" },
    });
    expect(idea?.prompt).toContain("- tests pass\n- README updated");
  });

  it("suggests a goal that ran out of rounds, not an active, blocked or complete one", () => {
    const ideas = resumeGoalIdeas(
      [
        goal({ sessionId: "s1", status: "budget_limited" }),
        goal({ sessionId: "s2", status: "active" }),
        goal({ sessionId: "s3", status: "blocked" }),
        goal({ sessionId: "s4", status: "complete" }),
        goal({ sessionId: "s5", openCriteria: [] }),
      ],
      NOW,
    );
    expect(ideas.map((i) => i.sessionId)).toEqual(["s1"]);
    expect(ideas[0]?.reason).toContain("ran out of rounds");
  });
});

describe("buildIdeaCandidates", () => {
  it("combines both rules", () => {
    const ideas = buildIdeaCandidates({ tasks: [task({ id: "a" })], goals: [goal()], now: NOW });
    expect(ideas.map((i) => i.kind)).toEqual(["retry_task", "resume_goal"]);
  });
});

describe("goalIdeaInputs", () => {
  it("reads the goal stored on a session and lists the unmet items", () => {
    const inputs = goalIdeaInputs([
      { id: "s-none", metadata: {} },
      {
        id: "s-goal",
        metadata: {
          goal: {
            version: 1,
            status: "paused",
            statusReason: "Stopped by you.",
            criteria: [
              { text: "tests pass", mark: "met" },
              { text: "docs updated", mark: "not_met" },
            ],
            checks: [],
            maxRounds: 10,
            roundsUsed: 3,
            judgeFailures: 0,
            createdAt: 5,
            updatedAt: 9,
          },
        },
      },
    ]);
    expect(inputs).toEqual([
      {
        sessionId: "s-goal",
        status: "paused",
        statusReason: "Stopped by you.",
        openCriteria: ["docs updated"],
        goalCreatedAt: 5,
        updatedAt: 9,
      },
    ]);
  });
});
