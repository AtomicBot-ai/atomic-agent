import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEmptySessionState } from "../session/index.js";
import type { SessionState } from "../session/index.js";

import { TaskRunner } from "./task-runner.js";
import type { TaskRunnerRuntime } from "./task-runner.js";
import { TaskStore } from "./task-store.js";
import { resolveScheduledFor } from "./task-schedule.js";
import type { TaskSchedule } from "./task-types.js";

/**
 * ATO-590: the scheduler's drain leaves a paused task alone until resumed;
 * "Run now" runs it once and it stays paused.
 */
describe("TaskRunner with a paused task", () => {
  let tmp: string;
  let store: TaskStore;
  let session: SessionState;
  let turns: string[];
  let runner: TaskRunner;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-runner-pause-"));
    store = new TaskStore({ dbFile: join(tmp, "tasks.sqlite") });
    session = createEmptySessionState({ id: "s-1", workingDir: "/tmp/work" });
    turns = [];
    const runtime: TaskRunnerRuntime = {
      runTurn: async (s, userMessage) => {
        turns.push(userMessage);
        return { session: s, reason: "reply", stepCount: 1 };
      },
    };
    runner = new TaskRunner({
      store,
      runtime,
      sessionLoader: { load: () => session },
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("skips it on runDue, runs it after resume, and logs the run", async () => {
    const task = store.create({
      sessionId: session.id,
      userMessage: "paused work",
      origin: "cli",
      maxAttempts: 1,
    });
    store.pause(task.id);

    const skipped = await runner.runDue(Date.now(), 10);
    expect(skipped.drained).toBe(0);
    expect(turns).toEqual([]);
    expect(store.get(task.id)?.status).toBe("paused");

    store.resume(task.id);
    await runner.runDue(Date.now(), 10);
    expect(turns).toEqual(["paused work"]);
    expect(store.get(task.id)?.status).toBe("completed");
    expect(store.listRuns(task.id).map((r) => r.outcome)).toEqual(["completed"]);
  });

  it("does not run it through runOne either", async () => {
    const task = store.create({
      sessionId: session.id,
      userMessage: "paused work",
      origin: "cli",
      maxAttempts: 1,
    });
    store.pause(task.id);
    const result = await runner.runOne(task.id);
    expect(result?.status).toBe("paused");
    expect(turns).toEqual([]);
  });

  describe("Run now (runOne with evenIfPaused)", () => {
    const cron: TaskSchedule = { kind: "cron", expression: "0 9 * * *", tz: "UTC" };

    function pausedRecurring() {
      const now = Date.now();
      const task = store.create(
        {
          sessionId: session.id,
          userMessage: "daily digest",
          origin: "cli",
          maxAttempts: 3,
          schedule: cron,
          scheduledFor: resolveScheduledFor(cron, now),
        },
        now,
      );
      store.pause(task.id);
      return task;
    }

    it("runs a paused recurring task once and leaves it paused", async () => {
      const task = pausedRecurring();

      const result = await runner.runOne(task.id, undefined, { evenIfPaused: true });

      expect(turns).toEqual(["daily digest"]);
      expect(result?.status).toBe("paused");
      expect(store.get(task.id)?.status).toBe("paused");
      expect(store.listRuns(task.id).map((r) => r.outcome)).toEqual(["completed"]);

      // Still paused: no firing, however late the scheduler looks.
      const later = Date.now() + 30 * 24 * 60 * 60 * 1000;
      const drained = await runner.runDue(later, 10);
      expect(drained.drained).toBe(0);
      expect(turns).toEqual(["daily digest"]);
      expect(store.get(task.id)?.status).toBe("paused");
    });

    it("runs again on a second Run now, still paused, one history row each", async () => {
      const task = pausedRecurring();
      await runner.runOne(task.id, undefined, { evenIfPaused: true });
      await runner.runOne(task.id, undefined, { evenIfPaused: true });
      expect(turns).toEqual(["daily digest", "daily digest"]);
      expect(store.get(task.id)?.status).toBe("paused");
      expect(store.listRuns(task.id)).toHaveLength(2);
    });

    it("lets a resume after it arm the schedule as usual", async () => {
      const task = pausedRecurring();
      await runner.runOne(task.id, undefined, { evenIfPaused: true });
      const resumed = store.resume(task.id);
      expect(resumed?.status).toBe("pending");
      expect(resumed?.scheduledFor).toBeGreaterThan(Date.now());
    });

    it("ends a paused one-shot task like any run (nothing left to pause)", async () => {
      const task = store.create({
        sessionId: session.id,
        userMessage: "once",
        origin: "cli",
        maxAttempts: 1,
      });
      store.pause(task.id);
      const result = await runner.runOne(task.id, undefined, { evenIfPaused: true });
      expect(turns).toEqual(["once"]);
      expect(result?.status).toBe("completed");
      expect(store.listRuns(task.id).map((r) => r.outcome)).toEqual(["completed"]);
    });

    it("does not pause a task that was not paused", async () => {
      const task = pausedRecurring();
      store.resume(task.id);
      const result = await runner.runOne(task.id, undefined, { evenIfPaused: true });
      expect(turns).toEqual(["daily digest"]);
      expect(result?.status).toBe("pending");
    });
  });
});
