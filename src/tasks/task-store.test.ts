import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";

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

  it("listDue returns only rows whose scheduled_for is <= now, ordered", () => {
    const immediate = store.create(
      { sessionId: "s-1", userMessage: "now", origin: "cli", maxAttempts: 1 },
      1_000,
    );
    const past = store.create(
      {
        sessionId: "s-1",
        userMessage: "past",
        origin: "scheduler",
        maxAttempts: 1,
        schedule: { kind: "at", at: 500 },
        scheduledFor: 500,
      },
      1_000,
    );
    const future = store.create(
      {
        sessionId: "s-1",
        userMessage: "future",
        origin: "scheduler",
        maxAttempts: 1,
        schedule: { kind: "at", at: 10_000 },
        scheduledFor: 10_000,
      },
      1_000,
    );
    const due = store.listDue(2_000);
    const ids = due.map((t) => t.id);
    expect(ids).toContain(immediate.id);
    expect(ids).toContain(past.id);
    expect(ids).not.toContain(future.id);
  });

  it("requeueRecurring atomically resets attempts + rearms scheduled_for without touching sessionId", () => {
    const created = store.create(
      {
        sessionId: "s-persistent",
        userMessage: "tick",
        origin: "scheduler",
        maxAttempts: 3,
        schedule: { kind: "interval", everyMs: 1_000 },
        scheduledFor: 1_000,
      },
      1_000,
    );
    store.markRunning(created.id, 1_500);
    store.markCompleted(created.id, 2_000);
    const requeued = store.requeueRecurring(created.id, 3_000, 2_500);
    expect(requeued.status).toBe("pending");
    expect(requeued.attempts).toBe(0);
    expect(requeued.lastError).toBeNull();
    expect(requeued.scheduledFor).toBe(3_000);
    expect(requeued.sessionId).toBe("s-persistent");
    expect(requeued.startedAt).toBeNull();
    expect(requeued.completedAt).toBeNull();
    expect(requeued.lastScheduledAt).toBe(2_500);
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

  it("defaults notify to null and round-trips an explicit telegram opt-in", () => {
    const silent = store.create(
      { sessionId: "s-1", userMessage: "quiet", origin: "cli", maxAttempts: 1 },
      1_000,
    );
    expect(silent.notify).toBeNull();
    expect(store.get(silent.id)?.notify).toBeNull();

    const loud = store.create(
      {
        sessionId: "s-1",
        userMessage: "report me",
        origin: "cli",
        maxAttempts: 1,
        notify: "telegram",
      },
      1_000,
    );
    expect(loud.notify).toBe("telegram");
    expect(store.get(loud.id)?.notify).toBe("telegram");
  });

  it("rejects a notify target outside the allow-list", () => {
    expect(() =>
      store.create({
        sessionId: "s-1",
        userMessage: "hi",
        origin: "cli",
        maxAttempts: 1,
        notify: "slack" as never,
      }),
    ).toThrow(TaskValidationError);
    try {
      store.create({
        sessionId: "s-1",
        userMessage: "hi",
        origin: "cli",
        maxAttempts: 1,
        notify: "slack" as never,
      });
    } catch (err) {
      expect((err as TaskValidationError).field).toBe("notify");
    }
  });

  it("migrates a real v2 database to v3: notify column added, old rows read as null, new writes work", () => {
    // Build a genuine v2-shaped database by hand: v1 base + v2 columns,
    // NO notify column, schema_meta version stamped '2', one live row.
    const dbFile = join(tmp, "tasks-v2.sqlite");
    const raw = new DatabaseCtor(dbFile);
    raw.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tasks (
        id              TEXT PRIMARY KEY,
        session_id      TEXT,
        user_message    TEXT NOT NULL,
        max_steps       INTEGER,
        status          TEXT NOT NULL,
        origin          TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        max_attempts    INTEGER NOT NULL,
        last_error      TEXT,
        last_error_cat  TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        started_at      INTEGER,
        completed_at    INTEGER,
        schedule_kind   TEXT,
        schedule_value  TEXT,
        scheduled_for   INTEGER,
        recurring       INTEGER NOT NULL DEFAULT 0,
        last_scheduled_at INTEGER,
        trigger_source  TEXT
      );
      CREATE INDEX idx_tasks_due
        ON tasks(status, scheduled_for) WHERE status = 'pending';
      INSERT INTO schema_meta (key, value) VALUES ('version', '2');
      INSERT INTO tasks (
        id, session_id, user_message, max_steps, status, origin,
        attempts, max_attempts, created_at, updated_at,
        schedule_kind, schedule_value, scheduled_for, recurring
      ) VALUES (
        't-v2-row', 's-old', 'pre-v3 cron', NULL, 'pending', 'cli',
        0, 3, 1000, 1000,
        'cron', '{"expression":"0 9 * * *"}', 2000, 1
      );
    `);
    const before = raw
      .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('tasks') WHERE name = 'notify'")
      .get() as { n: number };
    expect(before.n).toBe(0);
    raw.close();

    // Opening the store runs applyMigrations: v2 -> v3.
    const migrated = new TaskStore({ dbFile });
    try {
      // Pre-migration row reads back intact with notify clamped to null.
      const oldRow = migrated.get("t-v2-row");
      expect(oldRow).toMatchObject({
        userMessage: "pre-v3 cron",
        status: "pending",
        recurring: true,
        notify: null,
      });
      // New writes can use the column.
      const fresh = migrated.create({
        sessionId: "s-new",
        userMessage: "post-v3",
        origin: "cli",
        maxAttempts: 1,
        notify: "telegram",
      });
      expect(migrated.get(fresh.id)?.notify).toBe("telegram");
    } finally {
      migrated.close();
    }

    // Column exists and the on-disk version was bumped to '3'.
    const after = new DatabaseCtor(dbFile);
    try {
      const col = after
        .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('tasks') WHERE name = 'notify'")
        .get() as { n: number };
      expect(col.n).toBe(1);
      const version = after
        .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
        .get() as { value: string };
      expect(version.value).toBe("3");
    } finally {
      after.close();
    }
  });

  it("clamps an unknown persisted notify value to null on read", () => {
    const t = store.create(
      {
        sessionId: "s-1",
        userMessage: "hi",
        origin: "cli",
        maxAttempts: 1,
        notify: "telegram",
      },
      1_000,
    );
    // Simulate a row written by a newer schema / hand-edited DB.
    const raw = new DatabaseCtor(join(tmp, "tasks.sqlite"));
    raw.prepare("UPDATE tasks SET notify = ? WHERE id = ?").run("pager", t.id);
    raw.close();
    expect(store.get(t.id)?.notify).toBeNull();
  });
});
