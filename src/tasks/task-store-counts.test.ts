import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskStore } from "./task-store.js";

describe("TaskStore.countByStatus (ATO-646)", () => {
  let tmp: string;
  let store: TaskStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-task-counts-"));
    store = new TaskStore({ dbFile: join(tmp, "tasks.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const create = () =>
    store.create({ sessionId: "s-1", userMessage: "do it", origin: "cli", maxAttempts: 1 });

  it("is empty for an empty queue", () => {
    expect(store.countByStatus()).toEqual({});
  });

  it("counts every task by its current status, past the list() page size", () => {
    for (let i = 0; i < 120; i += 1) create();
    const running = create();
    const done = create();
    const cancelled = create();
    store.markRunning(running.id);
    store.markRunning(done.id);
    store.markCompleted(done.id);
    store.cancel(cancelled.id);

    expect(store.countByStatus()).toEqual({
      pending: 120,
      running: 1,
      completed: 1,
      cancelled: 1,
    });
  });
});
