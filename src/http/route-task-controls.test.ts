import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

/** ATO-590: pause, resume and run history over HTTP. */
describe("/api/tasks/:id/{pause,resume,runs}", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function createTask() {
    const session = harness.runtime.createSession();
    harness.runtime.sessionStore.save(session);
    return harness.runtime.taskStore.create({
      sessionId: session.id,
      userMessage: "scheduled work",
      origin: "http",
      maxAttempts: 3,
    });
  }

  it("pauses and resumes a pending task", async () => {
    const task = createTask();
    const paused = await fetch(`${harness.baseUrl}/api/tasks/${task.id}/pause`, {
      method: "POST",
    });
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { status: string }).status).toBe("paused");

    const listed = await fetch(`${harness.baseUrl}/api/tasks?status=paused`);
    const body = (await listed.json()) as { tasks: Array<{ id: string }> };
    expect(body.tasks.map((t) => t.id)).toEqual([task.id]);

    const resumed = await fetch(`${harness.baseUrl}/api/tasks/${task.id}/resume`, {
      method: "POST",
    });
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { status: string }).status).toBe("pending");
  });

  it("answers 409 for an ended task and 404 for an unknown one", async () => {
    const task = createTask();
    harness.runtime.taskStore.cancel(task.id);
    const conflict = await fetch(`${harness.baseUrl}/api/tasks/${task.id}/pause`, {
      method: "POST",
    });
    expect(conflict.status).toBe(409);

    for (const path of ["pause", "resume"]) {
      const missing = await fetch(`${harness.baseUrl}/api/tasks/missing/${path}`, {
        method: "POST",
      });
      expect(missing.status).toBe(404);
    }
    const runs = await fetch(`${harness.baseUrl}/api/tasks/missing/runs`);
    expect(runs.status).toBe(404);
  });

  it("lists the task's runs newest first", async () => {
    const task = createTask();
    const store = harness.runtime.taskStore;
    store.markRunning(task.id, 1_000);
    store.markRetry(task.id, { category: "transport", message: "boom" }, 1_100);
    store.markRunning(task.id, 1_200);

    const res = await fetch(`${harness.baseUrl}/api/tasks/${task.id}/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: Array<{ attempt: number; outcome: string | null; error: string | null }>;
      available: boolean;
    };
    expect(body.available).toBe(true);
    expect(body.runs).toEqual([
      expect.objectContaining({ attempt: 2, outcome: null }),
      expect.objectContaining({ attempt: 1, outcome: "retry", error: "boom" }),
    ]);

    const limited = await fetch(`${harness.baseUrl}/api/tasks/${task.id}/runs?limit=1`);
    expect(((await limited.json()) as { runs: unknown[] }).runs).toHaveLength(1);
    const bad = await fetch(`${harness.baseUrl}/api/tasks/${task.id}/runs?limit=0`);
    expect(bad.status).toBe(400);
  });
});
