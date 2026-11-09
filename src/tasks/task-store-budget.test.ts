import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { TaskStore } from "./task-store.js";
import { TASK_SCHEMA_VERSION } from "./task-schema.js";
import { TaskValidationError } from "./task-types.js";

/** Per-task budget columns (ATO-1108): `max_cost_usd`, `max_duration_ms`, `spent_usd`. */
describe("TaskStore budgets", () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "task-store-budget-"));
    store = new TaskStore({ dbFile: join(dir, "tasks.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips the budget fields; an unset budget reads back null", () => {
    const capped = store.create({
      userMessage: "overnight",
      origin: "cli",
      maxAttempts: 1,
      maxCostUsd: 3.5,
      maxDurationMs: 28_800_000,
    });
    const plain = store.create({ userMessage: "plain", origin: "cli", maxAttempts: 1 });
    expect(store.budgetsUnavailable).toBeNull();
    expect(store.get(capped.id)).toMatchObject({
      maxCostUsd: 3.5,
      maxDurationMs: 28_800_000,
      spentUsd: null,
    });
    expect(store.get(plain.id)).toMatchObject({
      maxCostUsd: null,
      maxDurationMs: null,
      spentUsd: null,
    });
  });

  it("records spend, and a recurring task starts each firing from nothing", () => {
    const every = store.create({
      sessionId: "s-every",
      userMessage: "tick",
      origin: "cli",
      maxAttempts: 1,
      maxCostUsd: 1,
      schedule: { kind: "interval", everyMs: 60_000 },
      scheduledFor: 0,
    });
    expect(store.recordSpend(every.id, 0.42)?.spentUsd).toBeCloseTo(0.42, 6);
    expect(store.recordElapsed(every.id, 5_000)?.elapsedMs).toBe(5_000);
    store.markRunning(every.id);
    store.markCompleted(every.id);
    const requeued = store.requeueRecurring(every.id, 120_000);
    expect(requeued.spentUsd).toBeNull();
    expect(requeued.elapsedMs).toBeNull();
    expect(requeued.maxCostUsd).toBe(1);
  });

  it("ignores a spend that is not a usable amount", () => {
    const task = store.create({ userMessage: "x", origin: "cli", maxAttempts: 1 });
    store.recordSpend(task.id, 0.1);
    expect(store.recordSpend(task.id, Number.NaN)?.spentUsd).toBeCloseTo(0.1, 6);
    expect(store.recordSpend(task.id, -1)?.spentUsd).toBeCloseTo(0.1, 6);
  });

  it.each([
    [{ maxCostUsd: 0 }, "maxCostUsd"],
    [{ maxCostUsd: -2 }, "maxCostUsd"],
    [{ maxCostUsd: Number.POSITIVE_INFINITY }, "maxCostUsd"],
    [{ maxDurationMs: 0 }, "maxDurationMs"],
    [{ maxDurationMs: 1.5 }, "maxDurationMs"],
  ])("rejects %o", (budget, field) => {
    let thrown: unknown;
    try {
      store.create({ userMessage: "x", origin: "cli", maxAttempts: 1, ...budget });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TaskValidationError);
    expect((thrown as TaskValidationError).field).toBe(field);
  });

  it("copies budgets with insertMissing", () => {
    const into = new TaskStore({ dbFile: join(dir, "into.sqlite") });
    try {
      const task = store.create({
        userMessage: "copied",
        origin: "cli",
        maxAttempts: 1,
        maxCostUsd: 5,
        maxDurationMs: 60_000,
      });
      store.recordSpend(task.id, 1.25);
      store.recordElapsed(task.id, 30_000);
      expect(into.insertMissing(store.list())).toEqual([task.id]);
      expect(into.get(task.id)).toMatchObject({
        maxCostUsd: 5,
        maxDurationMs: 60_000,
        spentUsd: 1.25,
        elapsedMs: 30_000,
      });
    } finally {
      into.close();
    }
  });

  it("adds the columns to an existing database without bumping its schema version", () => {
    const dbFile = join(dir, "older.sqlite");
    const older = new TaskStore({ dbFile });
    const kept = older.create({ id: "t-old", userMessage: "before", origin: "cli", maxAttempts: 1 });
    older.close();
    // Simulate a file an older binary wrote: drop the budget columns.
    const raw = new DatabaseCtor(dbFile);
    for (const column of ["max_cost_usd", "max_duration_ms", "spent_usd", "elapsed_ms"]) {
      raw.exec(`ALTER TABLE tasks DROP COLUMN ${column}`);
    }
    raw.close();

    const reopened = new TaskStore({ dbFile });
    try {
      expect(reopened.budgetsUnavailable).toBeNull();
      expect(reopened.get(kept.id)).toMatchObject({ userMessage: "before", maxCostUsd: null });
      const check = new DatabaseCtor(dbFile, { readonly: true });
      try {
        const version = check
          .prepare(`SELECT value FROM schema_meta WHERE key = 'version'`)
          .get() as { value: string };
        expect(Number(version.value)).toBe(TASK_SCHEMA_VERSION);
      } finally {
        check.close();
      }
    } finally {
      reopened.close();
    }
  });
});
