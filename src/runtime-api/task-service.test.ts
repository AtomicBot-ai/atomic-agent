import { describe, expect, it, vi } from "vitest";

import {
  TaskStateError,
  TaskValidationError,
  type TaskRecord,
} from "../tasks/index.js";

import { RuntimeApiError } from "./runtime-api-error.js";
import {
  cancelTask,
  createTask,
  drainTasks,
  getTask,
  listTasks,
  parseTaskStatusFilter,
  runTask,
  type TaskServiceDeps,
} from "./task-service.js";

function fakeRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t-1",
    sessionId: "s-1",
    userMessage: "hi",
    maxSteps: null,
    status: "pending",
    origin: "sidecar",
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
    lastErrorCategory: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: null,
    completedAt: null,
    schedule: null,
    scheduledFor: null,
    recurring: false,
    lastScheduledAt: null,
    triggerSource: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<TaskServiceDeps> = {}): TaskServiceDeps {
  return {
    config: { tasks: { enabled: true, maxAttempts: 3 } },
    taskRunner: {
      create: vi.fn(() => fakeRecord()),
      runOne: vi.fn(async () => fakeRecord({ status: "completed" })),
      drainPending: vi.fn(async () => ({
        drained: 1,
        completed: 1,
        failed: 0,
        blocked: 0,
        cancelled: 0,
        retried: 0,
      })),
    },
    taskStore: {
      get: vi.fn(() => fakeRecord()),
      list: vi.fn(() => [fakeRecord()]),
      cancel: vi.fn(() => fakeRecord({ status: "cancelled" })),
    },
    ...overrides,
  };
}

describe("task-service", () => {
  it("throws subsystem_disabled when tasks are off", () => {
    const deps = makeDeps({
      config: { tasks: { enabled: false, maxAttempts: 3 } },
    });
    expect(() => listTasks(deps)).toThrow(RuntimeApiError);
    try {
      createTask(deps, { userMessage: "x" });
    } catch (err) {
      expect((err as RuntimeApiError).code).toBe("subsystem_disabled");
    }
  });

  it("defaults maxAttempts and origin on create", () => {
    const deps = makeDeps();
    createTask(deps, { userMessage: "hello" });
    expect(deps.taskRunner.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: "hello",
        origin: "http",
        maxAttempts: 3,
      }),
    );
  });

  it("maps TaskValidationError to invalid_request with field", () => {
    const deps = makeDeps();
    (deps.taskRunner.create as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new TaskValidationError("userMessage", "bad");
      },
    );
    try {
      createTask(deps, { userMessage: "x" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeApiError);
      expect((err as RuntimeApiError).code).toBe("invalid_request");
      expect((err as RuntimeApiError).field).toBe("userMessage");
    }
  });

  it("rejects an empty userMessage before hitting the runner", () => {
    const deps = makeDeps();
    expect(() => createTask(deps, { userMessage: "" })).toThrow(RuntimeApiError);
    expect(deps.taskRunner.create).not.toHaveBeenCalled();
  });

  it("throws not_found when the task is missing", () => {
    const deps = makeDeps();
    (deps.taskStore.get as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(() => getTask(deps, "missing")).toThrow(RuntimeApiError);
    (deps.taskStore.cancel as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(() => cancelTask(deps, "missing")).toThrow(RuntimeApiError);
  });

  it("maps TaskStateError to conflict on run", async () => {
    const deps = makeDeps();
    (deps.taskRunner.runOne as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TaskStateError("running", "running", "t-1"),
    );
    await expect(runTask(deps, "t-1")).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("drains scoped to a session", async () => {
    const deps = makeDeps();
    await drainTasks(deps, { sessionId: "s-1" });
    expect(deps.taskRunner.drainPending).toHaveBeenCalledWith({
      sessionId: "s-1",
    });
  });
});

describe("parseTaskStatusFilter", () => {
  it("returns undefined for empty input", () => {
    expect(parseTaskStatusFilter(null)).toBeUndefined();
    expect(parseTaskStatusFilter("")).toBeUndefined();
  });

  it("parses a comma-separated list", () => {
    expect(parseTaskStatusFilter("pending,cancelled")).toEqual([
      "pending",
      "cancelled",
    ]);
  });

  it("throws invalid_request on an unknown status", () => {
    expect(() => parseTaskStatusFilter("nope")).toThrow(RuntimeApiError);
  });
});
