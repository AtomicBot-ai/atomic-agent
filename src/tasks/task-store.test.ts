import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskStore } from "./task-store.js";
import {
  TASK_USER_MESSAGE_MAX_LENGTH,
  TaskStateError,
  TaskValidationError,
} from "./task-types.js";

describe("TaskStore", () => {
  let tmp: string;
  let store: TaskStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-tasks-"));
    store = new TaskStore({ dbFile: join(tmp, "tasks.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a pending task with the supplied input", () => {
    const created = store.create(
      {
        sessionId: "s-1",
        userMessage: "check email",
        origin: "cli",
        maxAttempts: 3,
      },
      1_000,
    );
    expect(created).toMatchObject({
      sessionId: "s-1",
      userMessage: "check email",
      status: "pending",
      origin: "cli",
      attempts: 0,
      maxAttempts: 3,
      maxSteps: null,
      lastError: null,
      lastErrorCategory: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      startedAt: null,
      completedAt: null,
    });
    expect(created.id).toMatch(/^t-/);
  });

  it("rejects empty user messages and oversize ones", () => {
    expect(() =>
      store.create({
        sessionId: "s-1",
        userMessage: "",
        origin: "cli",
        maxAttempts: 1,
      }),
    ).toThrow(TaskValidationError);
    const oversized = "x".repeat(TASK_USER_MESSAGE_MAX_LENGTH + 1);
    expect(() =>
      store.create({
        sessionId: "s-1",
        userMessage: oversized,
        origin: "cli",
        maxAttempts: 1,
      }),
    ).toThrow(TaskValidationError);
  });

  it("rejects non-positive maxAttempts and maxSteps", () => {
    expect(() =>
      store.create({
        sessionId: "s-1",
        userMessage: "hi",
        origin: "cli",
        maxAttempts: 0,
      }),
    ).toThrow(TaskValidationError);
    expect(() =>
      store.create({
        sessionId: "s-1",
        userMessage: "hi",
        origin: "cli",
        maxAttempts: 1,
        maxSteps: -1,
      }),
    ).toThrow(TaskValidationError);
  });

  it("listPending returns oldest-first FIFO order", () => {
    const a = store.create(
      { sessionId: "s-1", userMessage: "a", origin: "cli", maxAttempts: 1 },
      1_000,
    );
    const b = store.create(
      { sessionId: "s-1", userMessage: "b", origin: "cli", maxAttempts: 1 },
      2_000,
    );
    const c = store.create(
      { sessionId: "s-2", userMessage: "c", origin: "cli", maxAttempts: 1 },
      3_000,
    );
    const pending = store.listPending();
    expect(pending.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    expect(store.listPending({ sessionId: "s-2" }).map((t) => t.id)).toEqual([c.id]);
  });

  it("markRunning bumps attempts, clears prior error, and is idempotent on the second call", () => {
    const created = store.create(
      { sessionId: "s-1", userMessage: "hi", origin: "cli", maxAttempts: 3 },
      1_000,
    );
    const claimed = store.markRunning(created.id, 1_500);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.startedAt).toBe(1_500);
    const second = store.markRunning(created.id, 2_000);
    expect(second).toBeNull();
  });

  it("markCompleted from running flips to completed and seals lastError", () => {
    const t = store.create(
      { sessionId: "s-1", userMessage: "hi", origin: "cli", maxAttempts: 1 },
      1_000,
    );
    store.markRunning(t.id, 1_500);
    const finished = store.markCompleted(t.id, 2_000);
    expect(finished.status).toBe("completed");
    expect(finished.completedAt).toBe(2_000);
    expect(finished.lastError).toBeNull();
  });

  it("markCompleted refuses to drag a non-running row", () => {
    const t = store.create(
      { sessionId: "s-1", userMessage: "hi", origin: "cli", maxAttempts: 1 },
      1_000,
    );
    expect(() => store.markCompleted(t.id, 2_000)).toThrow(TaskStateError);
  });

  it("markRetry moves running back to pending while keeping the error trace", () => {
    const t = store.create(
      { sessionId: "s-1", userMessage: "hi", origin: "cli", maxAttempts: 3 },
      1_000,
    );
    store.markRunning(t.id, 1_500);
    const retried = store.markRetry(
      t.id,
      { category: "transport", message: "boom" },
      2_000,
    );
    expect(retried.status).toBe("pending");
    expect(retried.attempts).toBe(1);
    expect(retried.lastError).toBe("boom");
    expect(retried.lastErrorCategory).toBe("transport");
    expect(retried.startedAt).toBeNull();
    const claimedAgain = store.markRunning(t.id, 3_000);
    expect(claimedAgain?.attempts).toBe(2);
  });

  it("markFailed records category and message, clamping oversized errors", () => {
    const t = store.create(
      { sessionId: "s-1", userMessage: "hi", origin: "cli", maxAttempts: 1 },
      1_000,
    );
    store.markRunning(t.id, 1_500);
    const huge = "y".repeat(5_000);
    const failed = store.markFailed(
      t.id,
      { category: "model", message: huge },
      2_000,
    );
    expect(failed.status).toBe("failed");
    expect(failed.lastErrorCategory).toBe("model");
    expect(failed.lastError?.length).toBeLessThanOrEqual(2_000);
    expect(failed.lastError?.endsWith("…")).toBe(true);
  });

  it("markBlocked accepts both running and pending sources", () => {
    const a = store.create(
      { sessionId: "s-1", userMessage: "hi", origin: "cli", maxAttempts: 1 },
      1_000,
    );
    const blocked = store.markBlocked(
      a.id,
      { category: "grammar", message: "permanent" },
      2_000,
    );
    expect(blocked.status).toBe("blocked");
    expect(blocked.attempts).toBe(0);
  });

  it("cancel is idempotent on terminal rows and a no-op on missing ids", () => {
    expect(store.cancel("missing")).toBeNull();
    const t = store.create(
      { sessionId: "s-1", userMessage: "hi", origin: "cli", maxAttempts: 1 },
      1_000,
    );
    const cancelled = store.cancel(t.id, 1_500);
    expect(cancelled?.status).toBe("cancelled");
    const again = store.cancel(t.id, 2_000);
    expect(again?.status).toBe("cancelled");
    expect(again?.completedAt).toBe(1_500);
  });

  it("recoverStale flips only running rows older than threshold", () => {
    const fresh = store.create(
      { sessionId: "s-1", userMessage: "fresh", origin: "cli", maxAttempts: 1 },
      10_000,
    );
    const stale = store.create(
      { sessionId: "s-1", userMessage: "stale", origin: "cli", maxAttempts: 1 },
      11_000,
    );
    store.markRunning(fresh.id, 19_500);
    store.markRunning(stale.id, 12_000);
    const flipped = store.recoverStale(5_000, 20_000);
    expect(flipped).toBe(1);
    expect(store.get(stale.id)?.status).toBe("pending");
    expect(store.get(fresh.id)?.status).toBe("running");
  });

  it("list filters by status", () => {
    const a = store.create(
      { sessionId: "s-1", userMessage: "a", origin: "cli", maxAttempts: 1 },
      1_000,
    );
    store.cancel(a.id, 1_500);
    store.create(
      { sessionId: "s-1", userMessage: "b", origin: "cli", maxAttempts: 1 },
      2_000,
    );
    expect(store.list({ status: "cancelled" }).map((t) => t.id)).toEqual([a.id]);
    expect(store.list({ status: ["pending", "cancelled"] }).length).toBe(2);
  });

  it("schema migration is idempotent across re-opens", () => {
    const t = store.create(
      { sessionId: "s-1", userMessage: "hi", origin: "cli", maxAttempts: 1 },
      1_000,
    );
    store.close();
    store = new TaskStore({ dbFile: join(tmp, "tasks.sqlite") });
    expect(store.get(t.id)?.userMessage).toBe("hi");
  });
});
