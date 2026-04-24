import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  TaskValidationError,
  type TaskRunner,
} from "../../tasks/index.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface TasksCronToolOptions {
  taskRunner: TaskRunner;
}

/**
 * `tasks.cron { userMessage, expression, tz? }` — schedule recurring
 * work. Unlike `tasks.schedule`, this tool **never** inherits the
 * caller's session: recurring runs deserve their own persistent
 * session so background autonomy never pollutes the user's active
 * thread. The runner's `create()` path will provision that session
 * up-front because `sessionId` is omitted and the schedule is
 * recurring (see `TaskRunner.create` resolution rules).
 *
 * Validation (cron expression, optional IANA tz) is performed at
 * dispatch time by `resolveScheduledFor` via `cron-parser`; errors
 * surface as `status: error` tool results rather than throws.
 */
export function buildTasksCronTool(
  options: TasksCronToolOptions,
): ToolDefinition {
  return {
    name: "tasks.cron",
    description:
      "Schedule a recurring task via a standard 5- or 6-field cron expression. Args: { userMessage, expression, tz? }. Each firing runs in its own persistent session (not the caller's).",
    readonly: false,
    async run(rawArgs) {
      const userMessage = rawArgs.userMessage;
      const expression = rawArgs.expression;
      if (typeof userMessage !== "string" || userMessage.length === 0) {
        return compressToolResult({
          tool: "tasks.cron",
          status: "error",
          output: "validation: userMessage must be a non-empty string",
          details: { field: "userMessage" },
        });
      }
      if (typeof expression !== "string" || expression.length === 0) {
        return compressToolResult({
          tool: "tasks.cron",
          status: "error",
          output: "validation: expression must be a non-empty cron string",
          details: { field: "expression" },
        });
      }
      const tz = rawArgs.tz;
      if (tz !== undefined && typeof tz !== "string") {
        return compressToolResult({
          tool: "tasks.cron",
          status: "error",
          output: "validation: tz must be a string when provided",
          details: { field: "tz" },
        });
      }
      try {
        const record = options.taskRunner.create({
          userMessage,
          origin: "agent",
          triggerSource: "agent",
          maxAttempts: 1,
          maxSteps: null,
          schedule: {
            kind: "cron",
            expression,
            ...(typeof tz === "string" ? { tz } : {}),
          },
        });
        return compressToolResult({
          tool: "tasks.cron",
          status: "ok",
          output: `scheduled recurring task ${record.id} (next: ${
            record.scheduledFor
              ? new Date(record.scheduledFor).toISOString()
              : "unknown"
          })`,
          details: {
            id: record.id,
            sessionId: record.sessionId,
            scheduledFor: record.scheduledFor,
            expression,
            tz: typeof tz === "string" ? tz : null,
          },
        });
      } catch (err) {
        if (err instanceof TaskValidationError) {
          return compressToolResult({
            tool: "tasks.cron",
            status: "error",
            output: `validation: ${err.field}: ${err.message}`,
            details: { field: err.field, reason: err.message },
          });
        }
        throw err;
      }
    },
  };
}
