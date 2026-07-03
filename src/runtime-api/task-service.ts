import {
  TaskStateError,
  TaskValidationError,
  type DrainOutcome,
  type TaskOrigin,
  type TaskRecord,
  type TaskSchedule,
  type TaskStatus,
} from "../tasks/index.js";

import { RuntimeApiError } from "./runtime-api-error.js";

/**
 * Narrow dependency surface for the task service. Structural typing lets
 * tests pass in-memory fakes without constructing a full `AgentRuntime`.
 */
export interface TaskServiceDeps {
  config: { tasks: { enabled: boolean; maxAttempts: number } };
  taskRunner: {
    create(input: {
      sessionId?: string | null;
      userMessage: string;
      origin: TaskOrigin;
      maxAttempts: number;
      maxSteps?: number | null;
      schedule?: TaskSchedule | null;
    }): TaskRecord;
    runOne(taskId: string): Promise<TaskRecord | null>;
    drainPending(opts: { sessionId?: string }): Promise<DrainOutcome>;
  };
  taskStore: {
    get(id: string): TaskRecord | null;
    list(opts: {
      sessionId?: string;
      status?: TaskStatus | TaskStatus[];
      limit?: number;
    }): TaskRecord[];
    cancel(id: string): TaskRecord | null;
  };
}

export interface CreateTaskInput {
  sessionId?: string | null;
  userMessage: string;
  origin?: TaskOrigin;
  maxAttempts?: number;
  maxSteps?: number | null;
  schedule?: TaskSchedule | null;
}

export interface ListTasksInput {
  sessionId?: string;
  status?: TaskStatus[];
  limit?: number;
}

function assertEnabled(deps: TaskServiceDeps): void {
  if (!deps.config.tasks.enabled) {
    throw new RuntimeApiError("tasks subsystem disabled", "subsystem_disabled");
  }
}

export function createTask(
  deps: TaskServiceDeps,
  input: CreateTaskInput,
): TaskRecord {
  assertEnabled(deps);
  if (typeof input.userMessage !== "string" || input.userMessage.length === 0) {
    throw new RuntimeApiError(
      "userMessage is required",
      "invalid_request",
      "userMessage",
    );
  }
  try {
    return deps.taskRunner.create({
      sessionId: input.sessionId ?? null,
      userMessage: input.userMessage,
      origin: input.origin ?? "http",
      maxAttempts: input.maxAttempts ?? deps.config.tasks.maxAttempts,
      maxSteps: input.maxSteps ?? null,
      schedule: input.schedule ?? null,
    });
  } catch (err) {
    if (err instanceof TaskValidationError) {
      throw new RuntimeApiError(err.message, "invalid_request", err.field);
    }
    throw err;
  }
}

export function listTasks(
  deps: TaskServiceDeps,
  input: ListTasksInput = {},
): TaskRecord[] {
  assertEnabled(deps);
  const limit = clampLimit(input.limit);
  return deps.taskStore.list({
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.status && input.status.length > 0 ? { status: input.status } : {}),
    limit,
  });
}

export function getTask(deps: TaskServiceDeps, taskId: string): TaskRecord {
  assertEnabled(deps);
  const record = deps.taskStore.get(taskId);
  if (!record) {
    throw new RuntimeApiError(`task not found: ${taskId}`, "not_found");
  }
  return record;
}

export function cancelTask(deps: TaskServiceDeps, taskId: string): TaskRecord {
  assertEnabled(deps);
  const cancelled = deps.taskStore.cancel(taskId);
  if (!cancelled) {
    throw new RuntimeApiError(`task not found: ${taskId}`, "not_found");
  }
  return cancelled;
}

export async function runTask(
  deps: TaskServiceDeps,
  taskId: string,
): Promise<TaskRecord | null> {
  assertEnabled(deps);
  const existing = deps.taskStore.get(taskId);
  if (!existing) {
    throw new RuntimeApiError(`task not found: ${taskId}`, "not_found");
  }
  try {
    return await deps.taskRunner.runOne(taskId);
  } catch (err) {
    if (err instanceof TaskStateError) {
      throw new RuntimeApiError(err.message, "conflict");
    }
    throw err;
  }
}

export async function drainTasks(
  deps: TaskServiceDeps,
  input: { sessionId?: string } = {},
): Promise<DrainOutcome> {
  assertEnabled(deps);
  return deps.taskRunner.drainPending(
    input.sessionId ? { sessionId: input.sessionId } : {},
  );
}

/** JSON projection shared by the HTTP and sidecar transports. */
export function serializeTask(record: TaskRecord): Record<string, unknown> {
  return {
    id: record.id,
    sessionId: record.sessionId,
    userMessage: record.userMessage,
    maxSteps: record.maxSteps,
    status: record.status,
    origin: record.origin,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    lastError: record.lastError,
    lastErrorCategory: record.lastErrorCategory,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    schedule: record.schedule,
    scheduledFor: record.scheduledFor,
    recurring: record.recurring,
    lastScheduledAt: record.lastScheduledAt,
    triggerSource: record.triggerSource,
  };
}

const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
];

/**
 * Parse a comma-separated `status` filter into a validated array.
 * Throws `invalid_request` on an unknown status so both transports reject
 * the same way.
 */
export function parseTaskStatusFilter(
  raw: string | null | undefined,
): TaskStatus[] | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const part of parts) {
    if (!TASK_STATUSES.includes(part as TaskStatus)) {
      throw new RuntimeApiError(
        `unknown task status: ${part}`,
        "invalid_request",
        "status",
      );
    }
  }
  return parts as TaskStatus[];
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RuntimeApiError(
      "limit must be a positive integer",
      "invalid_request",
      "limit",
    );
  }
  return Math.min(Math.floor(limit), 500);
}
