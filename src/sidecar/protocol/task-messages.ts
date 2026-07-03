/**
 * Request/response payload shapes for the `task.*` commands. See SIDECAR.md
 * §4.4. Task records are sent verbatim (`TaskRecord` is JSON-serializable);
 * the field set matches the HTTP transport's `recordToJson` projection.
 */
import type {
  DrainOutcome,
  TaskRecord,
  TaskSchedule,
  TaskStatus,
} from "../../tasks/index.js";

export interface TaskCreatePayload {
  sessionId?: string | null;
  userMessage: string;
  maxSteps?: number | null;
  maxAttempts?: number;
  schedule?: TaskSchedule | null;
}

export interface TaskCreateResult {
  task: TaskRecord;
}

export interface TaskListPayload {
  sessionId?: string;
  status?: TaskStatus[];
  limit?: number;
}

export interface TaskListResult {
  tasks: TaskRecord[];
}

export interface TaskGetPayload {
  taskId: string;
}

export interface TaskGetResult {
  task: TaskRecord | null;
}

export interface TaskCancelPayload {
  taskId: string;
}

export interface TaskCancelResult {
  task: TaskRecord | null;
}

export interface TaskRunPayload {
  taskId: string;
}

export interface TaskRunResult {
  task: TaskRecord | null;
}

export interface TaskDrainPayload {
  sessionId?: string;
}

export interface TaskDrainResult {
  outcome: DrainOutcome;
}
