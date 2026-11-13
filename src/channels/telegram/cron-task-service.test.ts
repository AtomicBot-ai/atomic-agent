import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntime } from "../../runtime/bootstrap.js";
import {
  TaskStore,
  resolveScheduledFor,
  type TaskCreateInput,
} from "../../tasks/index.js";

import { cronTaskServiceFromRuntime } from "./cron-task-service.js";

/**
 * The adapter against a real `TaskStore`; the runner is a thin stand-in
 * that resolves the first firing the way `TaskRunner.create` does.
 */
describe("cronTaskServiceFromRuntime", () => {
  let tmp: string;
  let store: TaskStore;
  let creates: TaskCreateInput[];
  let cancels: string[];

  function runtime(withScheduler = true): Partial<AgentRuntime> {
    return {
      taskStore: store,
      taskRunner: {
        create: (input: TaskCreateInput) => {
          creates.push(input);
          return store.create({
            ...input,
            sessionId: "s-cron",
            scheduledFor: resolveScheduledFor(input.schedule!, Date.now()),
          });
        },
        cancel: (id: string) => {
          cancels.push(id);
          return store.cancel(id);
        },
      } as unknown as AgentRuntime["taskRunner"],
      scheduler: (withScheduler ? {} : null) as AgentRuntime["scheduler"],
    };
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-cron-service-"));
    store = new TaskStore({ dbFile: join(tmp, "tasks.sqlite") });
    creates = [];
    cancels = [];
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("is null without a task queue", () => {
    expect(cronTaskServiceFromRuntime({})).toBeNull();
  });

  it("creates through the runner with Telegram reporting on by default", () => {
    const service = cronTaskServiceFromRuntime(runtime(), () => 4)!;
    const task = service.create({ expression: "0 9 * * *", tz: "UTC", message: "digest" });
    expect(creates).toEqual([
      {
        userMessage: "digest",
        origin: "telegram",
        triggerSource: "user",
        maxAttempts: 4,
        notify: "telegram",
        schedule: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
      },
    ]);
    expect(task.notify).toBe("telegram");
    expect(task.recurring).toBe(true);
    expect(service.list().map((t) => t.id)).toContain(task.id);
  });

  it("pauses, resumes and deletes against the store", () => {
    const service = cronTaskServiceFromRuntime(runtime(), () => 3)!;
    const { id } = service.create({ expression: "@hourly", message: "ping" });
    expect(service.pause(id)).toMatchObject({ ok: true, task: { status: "paused" } });
    expect(service.resume(id)).toMatchObject({ ok: true, task: { status: "pending" } });
    expect(service.remove(id)).toMatchObject({ ok: true, task: { status: "cancelled" } });
    expect(cancels).toEqual([id]);
  });

  it("deletes a paused task through the runner's cancel", () => {
    const service = cronTaskServiceFromRuntime(runtime(), () => 3)!;
    const { id } = service.create({ expression: "@daily", message: "x" });
    service.pause(id);
    expect(store.get(id)!.status).toBe("paused");
    expect(service.remove(id)).toMatchObject({ ok: true, task: { status: "cancelled" } });
    expect(cancels).toEqual([id]);
  });

  it("reports whether the scheduler runs", () => {
    expect(cronTaskServiceFromRuntime(runtime(true))!.schedulerRunning).toBe(true);
    expect(cronTaskServiceFromRuntime(runtime(false))!.schedulerRunning).toBe(false);
  });
});
