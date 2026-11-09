import { describe, expect, it } from "vitest";

import type { TurnProgress } from "../session/turn-progress.js";
import { planTaskResume, resumeNote } from "./task-resume.js";
import { TASK_INTERRUPTED_ERROR, TASK_OWNER_GONE_ERROR } from "./task-store.js";
import type { TaskRecord } from "./task-types.js";

function task(extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    sessionId: "s-1",
    userMessage: "rename every file",
    origin: "cli",
    status: "pending",
    attempts: 1,
    maxAttempts: 3,
    lastError: TASK_OWNER_GONE_ERROR,
    lastErrorCategory: "transport",
    createdAt: 1,
    updatedAt: 1,
    startedAt: null,
    completedAt: null,
    maxSteps: null,
    schedule: null,
    scheduledFor: null,
    recurring: false,
    lastScheduledAt: null,
    triggerSource: null,
    notify: null,
    ...extra,
  } as TaskRecord;
}

function progress(extra: Partial<TurnProgress> = {}): TurnProgress {
  return {
    stepsDone: 7,
    lastStepIndex: 6,
    request: "rename every file",
    options: { taskId: "task-1" },
    resumes: 0,
    startedAt: 1,
    updatedAt: 2,
    ...extra,
  };
}

const policy = { enabled: true, maxResumes: 3 };

describe("planTaskResume", () => {
  it("resumes a task whose agent died, with a note saying how far it got", () => {
    const plan = planTaskResume(task(), progress(), policy);
    expect(plan).toMatchObject({ kind: "resume", resumes: 1, crashed: true });
    if (plan.kind !== "resume") throw new Error("expected a resume");
    expect(plan.message).toContain("interrupted after step 7");
    expect(plan.message).toContain("do not redo finished work");
    expect(plan.message.endsWith("rename every file")).toBe(true);
  });

  it("resumes a one-shot task a shutdown left due without spending a resume", () => {
    const plan = planTaskResume(
      task({ lastError: TASK_INTERRUPTED_ERROR, lastErrorCategory: "cancelled" }),
      progress({ resumes: 2 }),
      policy,
    );
    expect(plan).toMatchObject({ kind: "resume", resumes: 2, crashed: false });
  });

  it("never resumes a run a person stopped", () => {
    // A recurring task stopped from its chat is rearmed with this error;
    // its next firing is a fresh run.
    expect(
      planTaskResume(
        task({ recurring: true, lastError: TASK_INTERRUPTED_ERROR }),
        progress(),
        policy,
      ),
    ).toEqual({ kind: "fresh" });
    // A first run, or a retry after a failure, is not an interruption.
    expect(planTaskResume(task({ lastError: null }), progress(), policy)).toEqual({ kind: "fresh" });
    expect(
      planTaskResume(task({ lastError: "loop reported failed" }), progress(), policy),
    ).toEqual({ kind: "fresh" });
  });

  it("starts fresh without a marker for this task, or when turned off", () => {
    expect(planTaskResume(task(), null, policy)).toEqual({ kind: "fresh" });
    expect(
      planTaskResume(task(), progress({ options: { taskId: "other" } }), policy),
    ).toEqual({ kind: "fresh" });
    expect(
      planTaskResume(task(), progress(), { enabled: false, maxResumes: 3 }),
    ).toEqual({ kind: "fresh" });
  });

  it("gives up past agent.task.maxResumes crash resumes", () => {
    expect(planTaskResume(task(), progress({ resumes: 2 }), policy)).toMatchObject({
      kind: "resume",
      resumes: 3,
    });
    const plan = planTaskResume(task(), progress({ resumes: 3 }), policy);
    expect(plan.kind).toBe("give_up");
    if (plan.kind !== "give_up") throw new Error("expected give_up");
    expect(plan.message).toContain("agent.task.maxResumes is 3");
    expect(
      planTaskResume(task(), progress(), { enabled: true, maxResumes: 0 }).kind,
    ).toBe("give_up");
  });

  it("words a cut before the first step", () => {
    expect(resumeNote(progress({ stepsDone: 0, lastStepIndex: -1 }))).toContain(
      "before its first step finished",
    );
  });
});
