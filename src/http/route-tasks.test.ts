import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

interface TaskJson {
  id: string;
  sessionId: string;
  userMessage: string;
  status: string;
  attempts: number;
  maxAttempts: number;
}

describe("/api/tasks", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("creates, fetches, and lists tasks scoped to the requested session", async () => {
    const session = harness.runtime.createSession();
    const createRes = await fetch(`${harness.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        userMessage: "hello",
        maxAttempts: 1,
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as TaskJson;
    expect(created).toMatchObject({
      sessionId: session.id,
      userMessage: "hello",
      maxAttempts: 1,
    });

    // Auto-drain may have already moved the task, so wait for the
    // create + immediate drain to settle before asserting on status.
    await harness.runtime.taskRunner.drainPending({ sessionId: session.id });

    const getRes = await fetch(`${harness.baseUrl}/api/tasks/${created.id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as TaskJson;
    expect(fetched.id).toBe(created.id);

    const listRes = await fetch(
      `${harness.baseUrl}/api/tasks?session=${session.id}`,
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { tasks: TaskJson[] };
    expect(listBody.tasks.map((t) => t.id)).toContain(created.id);
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await fetch(`${harness.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userMessage: "missing session" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown task ids on GET / DELETE / run", async () => {
    const get = await fetch(`${harness.baseUrl}/api/tasks/missing`);
    expect(get.status).toBe(404);
    const del = await fetch(`${harness.baseUrl}/api/tasks/missing`, {
      method: "DELETE",
    });
    expect(del.status).toBe(404);
    const run = await fetch(`${harness.baseUrl}/api/tasks/missing/run`, {
      method: "POST",
    });
    expect(run.status).toBe(404);
  });

  it("cancels a task and is idempotent on the second call", async () => {
    const session = harness.runtime.createSession();
    const created = harness.runtime.taskStore.create({
      sessionId: session.id,
      userMessage: "hi",
      origin: "http",
      maxAttempts: 1,
    });
    const first = await fetch(`${harness.baseUrl}/api/tasks/${created.id}`, {
      method: "DELETE",
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as TaskJson;
    expect(firstBody.status).toBe("cancelled");
    const second = await fetch(`${harness.baseUrl}/api/tasks/${created.id}`, {
      method: "DELETE",
    });
    expect(second.status).toBe(200);
  });

  it("filters list results by status", async () => {
    const session = harness.runtime.createSession();
    const a = harness.runtime.taskStore.create({
      sessionId: session.id,
      userMessage: "a",
      origin: "http",
      maxAttempts: 1,
    });
    harness.runtime.taskStore.cancel(a.id);
    harness.runtime.taskStore.create({
      sessionId: session.id,
      userMessage: "b",
      origin: "http",
      maxAttempts: 1,
    });
    const cancelledRes = await fetch(
      `${harness.baseUrl}/api/tasks?session=${session.id}&status=cancelled`,
    );
    const cancelledBody = (await cancelledRes.json()) as { tasks: TaskJson[] };
    expect(cancelledBody.tasks.map((t) => t.id)).toEqual([a.id]);
  });

  it("drains all pending tasks for a session via POST /api/tasks/drain", async () => {
    const session = harness.runtime.createSession();
    harness.runtime.taskStore.create({
      sessionId: session.id,
      userMessage: "first",
      origin: "http",
      maxAttempts: 1,
    });
    harness.runtime.taskStore.create({
      sessionId: session.id,
      userMessage: "second",
      origin: "http",
      maxAttempts: 1,
    });
    const drainRes = await fetch(
      `${harness.baseUrl}/api/tasks/drain?session=${session.id}`,
      { method: "POST" },
    );
    expect(drainRes.status).toBe(200);
    const outcome = (await drainRes.json()) as {
      drained: number;
      completed: number;
    };
    expect(outcome.drained).toBeGreaterThanOrEqual(2);
    expect(outcome.completed).toBeGreaterThanOrEqual(2);
  });
});
