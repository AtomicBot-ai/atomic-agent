import { compressToolResult } from "../../compressor/result-compressor.js";
import type { TaskStore } from "../../tasks/index.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface TasksCancelToolOptions {
  taskStore: TaskStore;
}

/**
 * `tasks.cancel { id }` — cancel a queued or already-running task.
 * Writeable. Idempotent on already-terminal rows: returns the existing
 * record unchanged. Unknown ids surface as `status: error` rather than
 * throwing so the agent can recover gracefully.
 */
export function buildTasksCancelTool(
  options: TasksCancelToolOptions,
): ToolDefinition {
  return {
    name: "tasks.cancel",
    description: "Cancel a queued or running task. Args: { id }.",
    readonly: false,
    async run(rawArgs) {
      const id = rawArgs.id;
      if (typeof id !== "string" || id.length === 0) {
        return compressToolResult({
          tool: "tasks.cancel",
          status: "error",
          output: "validation: id must be a non-empty string",
          details: { field: "id" },
        });
      }
      const cancelled = options.taskStore.cancel(id);
      if (!cancelled) {
        return compressToolResult({
          tool: "tasks.cancel",
          status: "error",
          output: `task not found: ${id}`,
          details: { id, notFound: true },
        });
      }
      return compressToolResult({
        tool: "tasks.cancel",
        status: "ok",
        output: `cancelled ${cancelled.id} (status=${cancelled.status})`,
        details: {
          id: cancelled.id,
          status: cancelled.status,
          sessionId: cancelled.sessionId,
        },
      });
    },
  };
}
