import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEmptySessionState } from "../session/index.js";
import type { SessionState } from "../session/index.js";

import { TaskRunner } from "./task-runner.js";
import type { TaskRunnerRuntime } from "./task-runner.js";
import { TaskStore } from "./task-store.js";

/** ATO-590: the scheduler's drain leaves a paused task alone until resumed. */
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
});
