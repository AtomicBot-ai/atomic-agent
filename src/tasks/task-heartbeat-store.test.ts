import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteHeartbeatStore, openPerCallHeartbeatStore } from "./task-heartbeat-store.js";
import { TaskStore } from "./task-store.js";

describe("SqliteHeartbeatStore", () => {
  let tmp: string;
  let dbFile: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-heartbeat-store-"));
    dbFile = join(tmp, "tasks.sqlite");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps a heartbeat's settings and its last outcome", () => {
    const store = new SqliteHeartbeatStore({ dbFile });
    try {
      store.put(
        {
          taskId: "t-1",
          checklistPath: "/state/HEARTBEAT.md",
          activeHours: { start: "08:00", end: "22:00" },
          osNotify: true,
        },
        1_000,
      );
      expect(store.get("t-1")).toEqual({
        taskId: "t-1",
        checklistPath: "/state/HEARTBEAT.md",
        activeHours: { start: "08:00", end: "22:00" },
        osNotify: true,
      });
      expect(store.state("t-1")).toMatchObject({ lastOutcome: null, lastCheckedAt: null });

      store.recordOutcome("t-1", "nothing_new", 5_000);
      expect(store.state("t-1")).toMatchObject({ lastOutcome: "nothing_new", lastCheckedAt: 5_000 });
      expect(store.list().map((s) => s.taskId)).toEqual(["t-1"]);

      store.remove("t-1");
      expect(store.get("t-1")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("updates the settings of an existing heartbeat in place", () => {
    const store = new SqliteHeartbeatStore({ dbFile });
    try {
      store.put({ taskId: "t-1", checklistPath: "/a", activeHours: null, osNotify: false });
      store.put({ taskId: "t-1", checklistPath: "/b", activeHours: null, osNotify: true });
      expect(store.list()).toHaveLength(1);
      expect(store.get("t-1")).toMatchObject({ checklistPath: "/b", osNotify: true });
    } finally {
      store.close();
    }
  });

  it("shares tasks.sqlite with the task store without touching its schema", () => {
    const tasks = new TaskStore({ dbFile });
    const store = new SqliteHeartbeatStore({ dbFile });
    try {
      store.put({ taskId: "t-1", checklistPath: "/a", activeHours: null, osNotify: false });
      const created = tasks.create({ userMessage: "x", origin: "cli", maxAttempts: 1 });
      expect(tasks.get(created.id)?.userMessage).toBe("x");
    } finally {
      store.close();
      tasks.close();
    }
  });

  it("answers per call without keeping the file open", () => {
    const writer = new SqliteHeartbeatStore({ dbFile });
    writer.put({ taskId: "t-1", checklistPath: "/a", activeHours: null, osNotify: false });
    writer.close();

    const perCall = openPerCallHeartbeatStore(dbFile);
    expect(perCall.get("t-1")?.checklistPath).toBe("/a");
    expect(perCall.get("t-other")).toBeNull();
    perCall.recordOutcome("t-1", "delivered", 9_000);

    const reader = new SqliteHeartbeatStore({ dbFile });
    try {
      expect(reader.state("t-1")).toMatchObject({ lastOutcome: "delivered", lastCheckedAt: 9_000 });
    } finally {
      reader.close();
    }
  });
});
