import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("stores maxCostUsd and maxDurationMs from the create body", async () => {
    const session = harness.runtime.createSession();
    const res = await fetch(`${harness.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        userMessage: "overnight",
        maxAttempts: 1,
        maxCostUsd: 5,
        maxDurationMs: 8 * 60 * 60 * 1000,
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as TaskJson & {
      maxCostUsd: number | null;
      maxDurationMs: number | null;
    };
    expect(created.maxCostUsd).toBe(5);
    expect(created.maxDurationMs).toBe(8 * 60 * 60 * 1000);
    const stored = harness.runtime.taskStore.get(created.id);
    expect(stored?.maxCostUsd).toBe(5);
    expect(stored?.maxDurationMs).toBe(8 * 60 * 60 * 1000);
  });

  it("returns the stop cause of a run a ceiling ended", async () => {
    const session = harness.runtime.createSession();
    const store = harness.runtime.taskStore;
    const task = store.create({
      sessionId: session.id,
      userMessage: "overnight",
      origin: "http",
      maxAttempts: 1,
    });
    store.markRunning(task.id);
    store.recordStopCause(task.id, "time_ceiling");
    store.markCompleted(task.id);
    const res = await fetch(`${harness.baseUrl}/api/tasks/${task.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskJson & { stopCause: string | null };
    expect(body.status).toBe("completed");
    expect(body.stopCause).toBe("time_ceiling");
  });

  it("leaves the budget null when the create body omits it", async () => {
    const session = harness.runtime.createSession();
    const res = await fetch(`${harness.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        userMessage: "no budget",
        maxAttempts: 1,
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      maxCostUsd: number | null;
      maxDurationMs: number | null;
    };
    expect(created.maxCostUsd).toBeNull();
    expect(created.maxDurationMs).toBeNull();
  });

  it.each([
    { maxCostUsd: 0 },
    { maxCostUsd: -1 },
    { maxCostUsd: "5" },
    { maxDurationMs: 0 },
    { maxDurationMs: 1.5 },
    { maxDurationMs: "3600000" },
  ])("rejects an invalid budget %j with 400", async (budget) => {
    const session = harness.runtime.createSession();
    const res = await fetch(`${harness.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        userMessage: "bad budget",
        maxAttempts: 1,
        ...budget,
      }),
    });
    expect(res.status).toBe(400);
    expect(
      harness.runtime.taskStore.list({ sessionId: session.id, limit: 10 }),
    ).toHaveLength(0);
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
    // Through the runner, which also stops the turn of a running task.
    const cancel = vi.spyOn(harness.runtime.taskRunner, "cancel");
    const first = await fetch(`${harness.baseUrl}/api/tasks/${created.id}`, {
      method: "DELETE",
    });
    expect(cancel).toHaveBeenCalledWith(created.id);
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

describe("tasks.minIntervalMs at runtime (#548)", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
    delete process.env.ATOMIC_AGENT_TASKS_MIN_INTERVAL_MS;
  });

  it("the booted runner enforces ATOMIC_AGENT_TASKS_MIN_INTERVAL_MS", async () => {
    process.env.ATOMIC_AGENT_TASKS_MIN_INTERVAL_MS = "30000";
    harness = await startTestHarness();
    const session = harness.runtime.createSession();
    const create = (everyMs: number) =>
      harness!.runtime.taskRunner.create({
        sessionId: session.id,
        userMessage: "poll",
        origin: "cli",
        maxAttempts: 1,
        schedule: { kind: "interval", everyMs },
      });

    expect(() => create(5_000)).toThrow(/>= 30000/);
    expect(create(30_000).schedule).toEqual({
      kind: "interval",
      everyMs: 30_000,
    });
  });
});

describe("POST /api/tasks/wake (ATO-592)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("answers 202 at once and says whether a tick started", async () => {
    const res = await fetch(`${harness.baseUrl}/api/tasks/wake`, { method: "POST" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { started: boolean; scheduler: boolean };
    expect(typeof body.started).toBe("boolean");
    expect(body.scheduler).toBe(harness.runtime.scheduler !== null);
    if (!body.scheduler) expect(body.started).toBe(false);
  });
});

describe("POST /api/tasks with workingDir and notify (ATO-1113)", () => {
  let harness: Harness;
  let dir: string;

  beforeEach(async () => {
    harness = await startTestHarness();
    dir = mkdtempSync(join(tmpdir(), "task-dir-"));
  });

  afterEach(async () => {
    await harness.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    fetch(`${harness.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("opens a new session in the folder and keeps notify", async () => {
    const res = await post({ userMessage: "tidy the repo", workingDir: dir, maxAttempts: 1, notify: "telegram" });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { sessionId: string; notify: string | null };
    expect(created.notify).toBe("telegram");
    const session = harness.runtime.sessionStore.load(created.sessionId);
    expect(session?.workingDir).toBe(dir);
  });

  it("refuses a folder that does not exist and leaves no session behind", async () => {
    const before = harness.runtime.sessionStore.listRecent(200).length;
    const res = await post({ userMessage: "x", workingDir: join(dir, "missing") });
    expect(res.status).toBe(400);
    expect(harness.runtime.sessionStore.listRecent(200).length).toBe(before);
  });

  it("deletes the session it opened when the task itself is refused", async () => {
    const before = harness.runtime.sessionStore.listRecent(200).length;
    const res = await post({ userMessage: "x".repeat(16_001), workingDir: dir });
    expect(res.status).toBe(400);
    expect(harness.runtime.sessionStore.listRecent(200).length).toBe(before);
  });

  it("refuses sessionId and workingDir together, and a notify target it does not know", async () => {
    const session = harness.runtime.createSession();
    expect((await post({ userMessage: "x", sessionId: session.id, workingDir: dir })).status).toBe(400);
    expect((await post({ userMessage: "x", workingDir: dir, notify: "email" })).status).toBe(400);
  });

  it("still requires a session or a folder", async () => {
    expect((await post({ userMessage: "x" })).status).toBe(400);
  });
});
