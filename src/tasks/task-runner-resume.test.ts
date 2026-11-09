import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEmptySessionState, type SessionState } from "../session/index.js";
import type { TurnProgress } from "../session/turn-progress.js";
import { TaskRunner, type TaskRunnerRuntime } from "./task-runner.js";
import { TASK_OWNER_GONE_ERROR, TaskStore } from "./task-store.js";

/**
 * A task run cut off from outside continues from its session's
 * checkpoint (ATO-1109); one a person stopped never does; a task the
 * agent keeps dying under is failed past `maxResumes`.
 */

interface Call {
  userMessage: string;
  checkpoint: { taskId?: string; resumes?: number; request?: string } | undefined;
}

describe("TaskRunner resume", () => {
  let tmp: string;
  let store: TaskStore;
  let session: SessionState;
  let markers: Map<string, TurnProgress>;
  let calls: Call[];
  let sleeps: number[];
  let onSleep: (() => void) | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-resume-"));
    store = new TaskStore({ dbFile: join(tmp, "tasks.sqlite") });
    session = createEmptySessionState({ id: "s-1", workingDir: "/tmp/work" });
    markers = new Map();
    calls = [];
    sleeps = [];
    onSleep = undefined;
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function runner(
    runTurn: TaskRunnerRuntime["runTurn"] = async (s) => ({
      session: s,
      reason: "reply",
      stepCount: 1,
    }),
    maxResumes = 3,
  ): TaskRunner {
    return new TaskRunner({
      store,
      runtime: {
        runTurn: async (s, userMessage, options) => {
          calls.push({ userMessage, checkpoint: options?.checkpoint });
          return runTurn(s, userMessage, options);
        },
      },
      sessionLoader: { load: () => session },
      defaultMaxSteps: 5,
      backoff: { initialMs: 100, maxMs: 1_000 },
      enabled: true,
      runOnCreate: false,
      sleep: async (ms) => {
        sleeps.push(ms);
        onSleep?.();
      },
      resume: {
        enabled: true,
        maxResumes,
        progress: {
          read: (id) => markers.get(id) ?? null,
          clear: (id) => {
            markers.delete(id);
          },
        },
      },
    });
  }

  /** The task as the boot sweep leaves it after its agent died mid-run. */
  function crashedTask(stepsDone: number, resumes = 0): string {
    const task = store.create({
      sessionId: session.id,
      userMessage: "rename every file",
      origin: "cli",
      maxAttempts: 3,
    });
    store.markRunning(task.id);
    store.recoverInterrupted({ staleAfterMs: 0, isOwnerGone: () => true });
    expect(store.get(task.id)?.lastError).toBe(TASK_OWNER_GONE_ERROR);
    markers.set(session.id, {
      stepsDone,
      lastStepIndex: stepsDone - 1,
      request: "rename every file",
      options: { taskId: task.id },
      resumes,
      startedAt: 1,
      updatedAt: 2,
    });
    return task.id;
  }

  it("resumes a crash-interrupted task with the note and counts the resume", async () => {
    const id = crashedTask(12);
    const final = await runner().runOne(id);
    expect(final?.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userMessage).toContain("interrupted after step 12");
    expect(calls[0]?.userMessage).toContain("do not redo finished work");
    expect(calls[0]?.userMessage.endsWith("rename every file")).toBe(true);
    expect(calls[0]?.checkpoint).toEqual({
      taskId: id,
      resumes: 1,
      request: "rename every file",
    });
    // The first crash resume starts at once.
    expect(sleeps).toEqual([]);
  });

  it("backs off a repeated crash resume", async () => {
    const id = crashedTask(3, 1);
    await runner().runOne(id);
    expect(calls[0]?.checkpoint?.resumes).toBe(2);
    expect(sleeps).toEqual([100]);
  });

  it("keeps the crash counted when the agent quits during the resume's backoff", async () => {
    const id = crashedTask(3, 1);
    const quit = new AbortController();
    onSleep = () => quit.abort();
    const final = await runner().runOne(id, quit.signal);
    expect(calls).toHaveLength(0);
    expect(final?.status).toBe("pending");
    // Still read as taken back from a dead agent: the next boot counts
    // this crash again instead of continuing it as a clean restart.
    expect(final?.lastError).toBe(TASK_OWNER_GONE_ERROR);
    expect(markers.get(session.id)?.resumes).toBe(1);
  });

  it("fails the task past maxResumes instead of running it again", async () => {
    const id = crashedTask(4, 3);
    const final = await runner().runOne(id);
    expect(calls).toHaveLength(0);
    expect(final?.status).toBe("failed");
    expect(final?.lastError).toContain("agent.task.maxResumes is 3");
    expect(markers.has(session.id)).toBe(false);
  });

  it("does not resume a run the person stopped", async () => {
    const task = store.create({
      sessionId: session.id,
      userMessage: "rename every file",
      origin: "cli",
      maxAttempts: 3,
    });
    // The person stops the turn from its chat: the loop ends cancelled
    // and the stopped turn keeps its marker.
    const stopped = await runner(async (s) => {
      markers.set(session.id, {
        stepsDone: 2,
        lastStepIndex: 1,
        request: "rename every file",
        options: { taskId: task.id },
        resumes: 0,
        startedAt: 1,
        updatedAt: 2,
      });
      return { session: s, reason: "cancelled", stepCount: 2 };
    }).runOne(task.id);
    expect(stopped?.status).toBe("cancelled");
    // Nothing runs it again, marker or not.
    expect(await runner().runOne(task.id)).toMatchObject({ status: "cancelled" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userMessage).toBe("rename every file");
  });

  it("starts fresh, naming the task in the marker, when nothing was interrupted", async () => {
    const task = store.create({
      sessionId: session.id,
      userMessage: "rename every file",
      origin: "cli",
      maxAttempts: 3,
    });
    await runner().runOne(task.id);
    expect(calls[0]).toEqual({
      userMessage: "rename every file",
      checkpoint: { taskId: task.id, resumes: 0, request: "rename every file" },
    });
  });
});
