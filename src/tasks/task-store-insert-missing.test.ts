import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TASK_OWNER_GONE_ERROR, TaskStore } from "./task-store.js";

describe("TaskStore.insertMissing", () => {
  let dir: string;
  let from: TaskStore;
  let into: TaskStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "task-insert-missing-"));
    from = new TaskStore({ dbFile: join(dir, "from.sqlite") });
    into = new TaskStore({ dbFile: join(dir, "into.sqlite") });
  });

  afterEach(() => {
    from.close();
    into.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies records with their ids and schedules, keeping a stored id as it is", () => {
    from.create({
      id: "t-every",
      userMessage: "tick",
      origin: "scheduler",
      maxAttempts: 2,
      schedule: { kind: "interval", everyMs: 60_000 },
      scheduledFor: 5_000,
      notify: "telegram",
    });
    from.create({ id: "t-mine", userMessage: "theirs", origin: "cli", maxAttempts: 1 });
    into.create({ id: "t-mine", userMessage: "mine", origin: "cli", maxAttempts: 1 });

    const inserted = into.insertMissing(from.list());

    expect(inserted).toEqual(["t-every"]);
    expect(into.get("t-every")).toEqual(from.get("t-every"));
    expect(into.get("t-mine")?.userMessage).toBe("mine");
  });

  it("puts a running record back to pending with no claim", () => {
    from.create({ id: "t-run", userMessage: "go", origin: "tui", maxAttempts: 3 });
    const running = from.markRunning("t-run");
    expect(running?.status).toBe("running");

    into.insertMissing([running!]);

    const copied = into.get("t-run");
    expect(copied?.status).toBe("pending");
    expect(copied?.startedAt).toBeNull();
    expect(copied?.lastError).toBe(TASK_OWNER_GONE_ERROR);
    expect(into.listDue(Date.now()).map((t) => t.id)).toEqual(["t-run"]);
    expect(into.recoverInterrupted({ staleAfterMs: 0, isOwnerGone: () => true })).toEqual([]);
  });
});
