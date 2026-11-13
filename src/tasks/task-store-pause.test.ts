import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";

import { resolveScheduledFor } from "./task-schedule.js";
import { TASK_RUNS_KEPT_PER_TASK } from "./task-run-log.js";
import { TaskStore } from "./task-store.js";
import { TaskStateError, type TaskSchedule } from "./task-types.js";

/** ATO-590: pause / resume and the per-run history. */
describe("TaskStore pause, resume and run history", () => {
  let tmp: string;
  let store: TaskStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-task-pause-"));
    store = new TaskStore({ dbFile: join(tmp, "tasks.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const cron: TaskSchedule = { kind: "cron", expression: "0 9 * * *", tz: "UTC" };

  function recurring(now: number) {
    return store.create(
      {
        sessionId: "s-1",
        userMessage: "daily digest",
        origin: "cli",
        maxAttempts: 3,
        schedule: cron,
        scheduledFor: resolveScheduledFor(cron, now),
      },
      now,
    );
  }

  function oneShot(id?: string) {
    return store.create({
      sessionId: "s-1",
      userMessage: "once",
      origin: "cli",
      maxAttempts: 3,
      ...(id ? { id } : {}),
    });
  }

  describe("pause", () => {
    it("takes a pending task out of the due and pending queries", () => {
      const task = oneShot();
      expect(store.listDue(Date.now()).map((t) => t.id)).toContain(task.id);

      const paused = store.pause(task.id);
      expect(paused?.status).toBe("paused");
      expect(store.listDue(Date.now() + 365 * 86_400_000)).toEqual([]);
      expect(store.listPending()).toEqual([]);
      expect(store.markRunning(task.id)).toBeNull();
    });

    it("keeps the schedule's time and is idempotent", () => {
      const now = Date.UTC(2030, 0, 1, 12, 0, 0);
      const task = recurring(now);
      const first = store.pause(task.id, now + 1);
      const second = store.pause(task.id, now + 2);
      expect(first?.scheduledFor).toBe(task.scheduledFor);
      expect(second?.status).toBe("paused");
      expect(second?.updatedAt).toBe(now + 1);
    });

    it("refuses a running or ended task and answers null for an unknown one", () => {
      const running = oneShot();
      store.markRunning(running.id);
      expect(() => store.pause(running.id)).toThrow(TaskStateError);

      const ended = oneShot();
      store.cancel(ended.id);
      expect(() => store.pause(ended.id)).toThrow(TaskStateError);

      expect(store.pause("t-missing")).toBeNull();
    });

    it("can be cancelled while paused", () => {
      const task = oneShot();
      store.pause(task.id);
      expect(store.cancel(task.id)?.status).toBe("cancelled");
    });

    it("lists under the paused status filter", () => {
      const task = oneShot();
      store.pause(task.id);
      expect(store.list({ status: "paused" }).map((t) => t.id)).toEqual([task.id]);
    });
  });

  describe("resume", () => {
    it("arms a recurring task for its next firing after the resume", () => {
      const created = Date.UTC(2030, 0, 1, 12, 0, 0);
      const task = recurring(created);
      store.pause(task.id, created + 1);
      // Paused across several 09:00 firings; none of them is owed.
      const resumedAt = Date.UTC(2030, 0, 5, 10, 30, 0);
      const resumed = store.resume(task.id, resumedAt);
      expect(resumed?.status).toBe("pending");
      expect(resumed?.scheduledFor).toBe(Date.UTC(2030, 0, 6, 9, 0, 0));
      expect(resumed?.lastScheduledAt).toBe(resumedAt);
      expect(store.listDue(resumedAt)).toEqual([]);
    });

    it("keeps a one-shot task's time, so a past one is due at once", () => {
      const task = oneShot();
      store.pause(task.id);
      const resumed = store.resume(task.id);
      expect(resumed?.status).toBe("pending");
      expect(resumed?.scheduledFor).toBeNull();
      expect(store.listDue(Date.now()).map((t) => t.id)).toContain(task.id);
    });

    it("is idempotent on pending and refuses an ended task", () => {
      const task = oneShot();
      expect(store.resume(task.id)?.status).toBe("pending");
      store.cancel(task.id);
      expect(() => store.resume(task.id)).toThrow(TaskStateError);
      expect(store.resume("t-missing")).toBeNull();
    });
  });

  describe("run history", () => {
    it("writes one row per run with its outcome, newest first", () => {
      const task = oneShot();
      store.markRunning(task.id, 1_000);
      store.markRetry(task.id, { category: "transport", message: "boom" }, 1_100);
      store.markRunning(task.id, 1_200);
      store.markCompleted(task.id, 1_300);

      const runs = store.listRuns(task.id);
      expect(runs).toHaveLength(2);
      expect(runs[0]).toMatchObject({
        taskId: task.id,
        attempt: 2,
        sessionId: "s-1",
        startedAt: 1_200,
        endedAt: 1_300,
        outcome: "completed",
        error: null,
      });
      expect(runs[1]).toMatchObject({
        attempt: 1,
        startedAt: 1_000,
        endedAt: 1_100,
        outcome: "retry",
        error: "boom",
        errorCategory: "transport",
      });
    });

    it("shows a run in progress as open", () => {
      const task = oneShot();
      store.markRunning(task.id, 5_000);
      expect(store.listRuns(task.id)[0]).toMatchObject({
        startedAt: 5_000,
        endedAt: null,
        outcome: null,
      });
    });

    it("records failed, blocked, cancelled and interrupted runs", () => {
      const failed = oneShot();
      store.markRunning(failed.id, 1);
      store.markFailed(failed.id, { category: "model", message: "bad" }, 2);
      expect(store.listRuns(failed.id)[0]?.outcome).toBe("failed");

      const blocked = oneShot();
      store.markRunning(blocked.id, 1);
      store.markBlocked(blocked.id, { category: "tool", message: "no session" }, 2);
      expect(store.listRuns(blocked.id)[0]?.outcome).toBe("blocked");

      const cancelled = oneShot();
      store.markRunning(cancelled.id, 1);
      store.cancel(cancelled.id, 2);
      expect(store.listRuns(cancelled.id)[0]?.outcome).toBe("cancelled");

      const interrupted = oneShot();
      store.markRunning(interrupted.id, 1);
      store.markInterrupted(interrupted.id, { nextScheduledFor: null }, 2);
      expect(store.listRuns(interrupted.id)[0]).toMatchObject({
        outcome: "interrupted",
        errorCategory: "cancelled",
      });
    });

    it("writes nothing for a transition with no run behind it", () => {
      const task = oneShot();
      store.cancel(task.id);
      expect(store.listRuns(task.id)).toEqual([]);
    });

    it("closes a run left open by something that does not write the log", () => {
      const task = oneShot();
      store.markRunning(task.id, 1_000);
      // An older binary on the same file ends the run without the log.
      const db = new DatabaseCtor(join(tmp, "tasks.sqlite"));
      try {
        db.prepare(`UPDATE tasks SET status = 'pending' WHERE id = ?`).run(task.id);
      } finally {
        db.close();
      }
      store.markRunning(task.id, 2_000);
      const runs = store.listRuns(task.id);
      expect(runs.map((r) => r.outcome)).toEqual([null, "unknown"]);
      expect(runs[1]?.endedAt).toBe(2_000);
    });

    it("records the boot sweep taking a run back", () => {
      const task = oneShot();
      store.markRunning(task.id, 1_000);
      const recovered = store.recoverInterrupted({
        staleAfterMs: 1,
        now: 10_000,
        isOwnerGone: () => true,
      });
      expect(recovered).toEqual([task.id]);
      expect(store.listRuns(task.id)[0]).toMatchObject({
        outcome: "interrupted",
        endedAt: 10_000,
      });
    });

    it("keeps a recurring task's runs across requeues", () => {
      const now = Date.UTC(2030, 0, 1, 12, 0, 0);
      const task = recurring(now);
      for (let i = 0; i < 3; i += 1) {
        const at = now + i * 1_000;
        store.markRunning(task.id, at);
        store.markCompleted(task.id, at + 10);
        store.requeueRecurring(task.id, at + 86_400_000, at + 20);
      }
      const runs = store.listRuns(task.id);
      expect(runs).toHaveLength(3);
      expect(runs.every((r) => r.outcome === "completed")).toBe(true);
      expect(runs.map((r) => r.attempt)).toEqual([1, 1, 1]);
    });

    it("keeps at most TASK_RUNS_KEPT_PER_TASK rows per task", () => {
      const task = oneShot();
      const total = TASK_RUNS_KEPT_PER_TASK + 5;
      for (let i = 0; i < total; i += 1) {
        store.markRunning(task.id, i * 10);
        store.markRetry(task.id, { category: "transport", message: `r${i}` }, i * 10 + 1);
      }
      const runs = store.listRuns(task.id, TASK_RUNS_KEPT_PER_TASK + 50);
      expect(runs).toHaveLength(TASK_RUNS_KEPT_PER_TASK);
      expect(runs[0]?.error).toBe(`r${total - 1}`);
    });

    it("keeps runs per task apart and honours the limit", () => {
      const a = oneShot("t-a");
      const b = oneShot("t-b");
      store.markRunning(a.id, 1);
      store.markCompleted(a.id, 2);
      store.markRunning(b.id, 3);
      expect(store.listRuns(a.id).map((r) => r.taskId)).toEqual(["t-a"]);
      expect(store.listRuns(b.id, 1)).toHaveLength(1);
      expect(store.runLogUnavailable).toBeNull();
    });
  });
});
