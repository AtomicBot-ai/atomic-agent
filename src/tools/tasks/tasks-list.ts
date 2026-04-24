import { compressToolResult } from "../../compressor/result-compressor.js";
import type { TaskRecord, TaskStatus, TaskStore } from "../../tasks/index.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface TasksListToolOptions {
  taskStore: TaskStore;
  defaultLimit: number;
}

const ALLOWED_STATUSES: readonly TaskStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
];

/**
 * `tasks.list { status?, sessionId?, limit? }` — readonly listing of
 * the task queue. Defaults to listing every status for the current
 * session; pass `sessionId` explicitly to inspect another thread, or
 * `status` (one value or a comma-separated list) to filter. `limit`
 * is hard-capped to keep tool results under the compressor budget.
 */
export function buildTasksListTool(
  options: TasksListToolOptions,
): ToolDefinition {
  return {
    name: "tasks.list",
    description:
      "List tasks in the durable queue. Args: { status?, sessionId?, limit? }. Defaults to the current session.",
    readonly: true,
    async run(rawArgs, ctx) {
      const limit = parseLimit(rawArgs.limit, options.defaultLimit);
      const sessionId =
        typeof rawArgs.sessionId === "string" && rawArgs.sessionId.length > 0
          ? rawArgs.sessionId
          : ctx.sessionId;
      const status = parseStatus(rawArgs.status);
      if (status === "invalid") {
        return compressToolResult({
          tool: "tasks.list",
          status: "error",
          output: `validation: status must be one of ${ALLOWED_STATUSES.join("|")} or a comma-separated subset`,
          details: { field: "status" },
        });
      }
      const records = options.taskStore.list({
        sessionId,
        ...(status ? { status } : {}),
        limit,
      });
      const output =
        records.length === 0
          ? "(no tasks)"
          : records.map(renderTaskLine).join("\n");
      return compressToolResult(
        {
          tool: "tasks.list",
          status: "ok",
          output,
          details: {
            count: records.length,
            sessionId,
            tasks: records.map(toSummary),
          },
        },
        { maxSummaryLength: 4000, maxTailLines: 200 },
      );
    },
  };
}

function parseLimit(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(raw), 200);
}

function parseStatus(raw: unknown): TaskStatus[] | undefined | "invalid" {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return "invalid";
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  for (const part of parts) {
    if (!ALLOWED_STATUSES.includes(part as TaskStatus)) return "invalid";
  }
  return parts as TaskStatus[];
}

function renderTaskLine(record: TaskRecord): string {
  const schedulePart = record.schedule
    ? ` [${record.schedule.kind}${record.recurring ? ":recurring" : ""}]`
    : "";
  const nextRun = record.scheduledFor
    ? ` next=${new Date(record.scheduledFor).toISOString()}`
    : "";
  return `- ${record.id} ${record.status}${schedulePart}${nextRun} :: ${truncate(record.userMessage, 80)}`;
}

function toSummary(record: TaskRecord): Record<string, unknown> {
  return {
    id: record.id,
    sessionId: record.sessionId,
    status: record.status,
    origin: record.origin,
    triggerSource: record.triggerSource,
    scheduledFor: record.scheduledFor,
    recurring: record.recurring,
    schedule: record.schedule,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    createdAt: record.createdAt,
  };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
