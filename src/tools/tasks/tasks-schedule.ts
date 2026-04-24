import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  TaskValidationError,
  type TaskRunner,
  type TaskSchedule,
} from "../../tasks/index.js";
import type { SessionState } from "../../session/index.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface TasksScheduleToolOptions {
  taskRunner: TaskRunner;
  /**
   * Factory used when `newSession: true` — the tool needs to provision
   * a fresh ephemeral session at schedule time rather than letting the
   * runner do it lazily, so the returned task id has a stable
   * sessionId the caller can inspect immediately.
   */
  createSession(input?: {
    metadata?: Record<string, unknown>;
  }): SessionState;
  defaultMaxAttempts: number;
}

/**
 * `tasks.schedule { userMessage, at?, inSeconds?, newSession? }` — the
 * agent's one-shot self-scheduling primitive. Writeable because each
 * call queues durable work that the scheduler will later dispatch
 * through a real `runTurn`.
 *
 * Session lifetime:
 *  - Default: inherits the *current* session id (read from the
 *    surrounding `ToolContext.sessionId`) so scheduled work continues
 *    the same thread when it fires.
 *  - `newSession: true`: provisions a fresh ephemeral session now and
 *    binds the task to it. Use when the deferred work is independent
 *    of the current thread (e.g. a reminder the caller does not want
 *    back in their own conversation).
 *
 * `at` (Unix ms) and `inSeconds` are mutually exclusive; omit both to
 * enqueue eagerly (the scheduler will still drain it at the next tick
 * or the existing `runOnCreate` path if enabled).
 */
export function buildTasksScheduleTool(
  options: TasksScheduleToolOptions,
): ToolDefinition {
  return {
    name: "tasks.schedule",
    description:
      "Schedule a one-shot task for the agent to run later. Args: { userMessage, at? (Unix ms), inSeconds?, newSession? }. Defaults to inheriting the current session; set newSession=true for an independent thread.",
    readonly: false,
    async run(rawArgs, ctx) {
      const userMessage = rawArgs.userMessage;
      if (typeof userMessage !== "string" || userMessage.length === 0) {
        return compressToolResult({
          tool: "tasks.schedule",
          status: "error",
          output: "validation: userMessage must be a non-empty string",
          details: { field: "userMessage" },
        });
      }
      let schedule: TaskSchedule | null;
      try {
        schedule = parseOneShotSchedule(rawArgs);
      } catch (err) {
        if (err instanceof TaskValidationError) {
          return compressToolResult({
            tool: "tasks.schedule",
            status: "error",
            output: `validation: ${err.field}: ${err.message}`,
            details: { field: err.field, reason: err.message },
          });
        }
        throw err;
      }
      const newSession = rawArgs.newSession === true;
      let sessionId: string | null = ctx.sessionId;
      if (newSession) {
        const fresh = options.createSession({
          metadata: {
            ephemeralTask: true,
            scheduledBy: ctx.sessionId,
            triggerSource: "agent",
          },
        });
        sessionId = fresh.id;
      }
      try {
        const record = options.taskRunner.create({
          sessionId,
          userMessage,
          origin: "agent",
          triggerSource: "agent",
          maxAttempts: options.defaultMaxAttempts,
          maxSteps: null,
          ...(schedule ? { schedule } : {}),
        });
        return compressToolResult({
          tool: "tasks.schedule",
          status: "ok",
          output: `scheduled task ${record.id}${
            record.scheduledFor
              ? ` for ${new Date(record.scheduledFor).toISOString()}`
              : ""
          }`,
          details: {
            id: record.id,
            sessionId: record.sessionId,
            scheduledFor: record.scheduledFor,
          },
        });
      } catch (err) {
        if (err instanceof TaskValidationError) {
          return compressToolResult({
            tool: "tasks.schedule",
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

function parseOneShotSchedule(
  rawArgs: Record<string, unknown>,
): TaskSchedule | null {
  const at = rawArgs.at;
  const inSeconds = rawArgs.inSeconds;
  if (at !== undefined && inSeconds !== undefined) {
    throw new TaskValidationError(
      "schedule",
      "pass either `at` or `inSeconds`, not both",
    );
  }
  if (typeof at === "number" && Number.isFinite(at)) {
    return { kind: "at", at };
  }
  if (typeof inSeconds === "number" && Number.isFinite(inSeconds)) {
    return { kind: "at", at: Date.now() + Math.round(inSeconds * 1_000) };
  }
  return null;
}
