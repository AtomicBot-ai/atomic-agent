import { compressToolResult } from "../../compressor/result-compressor.js";
import type { TaskStore } from "../../tasks/index.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface TasksShowToolOptions {
  taskStore: TaskStore;
}

/**
 * `tasks.show { id }` — readonly full-record fetch for one task.
 * Complements `tasks.list` when the agent needs every field (error
 * category, schedule details, timestamps) for decision making.
 */
export function buildTasksShowTool(
  options: TasksShowToolOptions,
): ToolDefinition {
  return {
    name: "tasks.show",
    description: "Show one task record by id. Args: { id }.",
    readonly: true,
    async run(rawArgs) {
      const id = rawArgs.id;
      if (typeof id !== "string" || id.length === 0) {
        return compressToolResult({
          tool: "tasks.show",
          status: "error",
          output: "validation: id must be a non-empty string",
          details: { field: "id" },
        });
      }
      const record = options.taskStore.get(id);
      if (!record) {
        return compressToolResult({
          tool: "tasks.show",
          status: "error",
          output: `task not found: ${id}`,
          details: { id, notFound: true },
        });
      }
      const schedulePart = record.schedule
        ? ` schedule=${record.schedule.kind}`
        : "";
      const nextRun = record.scheduledFor
        ? ` next=${new Date(record.scheduledFor).toISOString()}`
        : "";
      return compressToolResult({
        tool: "tasks.show",
        status: "ok",
        output: `${record.id} status=${record.status}${schedulePart}${nextRun} attempts=${record.attempts}/${record.maxAttempts}`,
        details: {
          id: record.id,
          sessionId: record.sessionId,
          status: record.status,
          origin: record.origin,
          triggerSource: record.triggerSource,
          userMessage: record.userMessage,
          attempts: record.attempts,
          maxAttempts: record.maxAttempts,
          lastError: record.lastError,
          lastErrorCategory: record.lastErrorCategory,
          schedule: record.schedule,
          scheduledFor: record.scheduledFor,
          recurring: record.recurring,
          lastScheduledAt: record.lastScheduledAt,
          notify: record.notify,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          startedAt: record.startedAt,
          completedAt: record.completedAt,
        },
      });
    },
  };
}
