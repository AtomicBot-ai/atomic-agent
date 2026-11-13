import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";
import { checkWorkingDir } from "./session-working-dir.js";
import {
  TaskStateError,
  TaskValidationError,
  type TaskRecord,
  type TaskStatus,
} from "../tasks/index.js";
import {
  validateMaxCostUsd,
  validateMaxDurationMs,
} from "../tasks/task-budget.js";

/**
 * `POST /api/tasks` — persist a new task. Body shape:
 *
 *  ```json
 *  { "sessionId": "s-…", "userMessage": "…", "maxAttempts": 3, "maxSteps": 10,
 *    "maxCostUsd": 5, "maxDurationMs": 28800000 }
 *  ```
 *
 * Instead of `sessionId` a client may send `workingDir` (an absolute path
 * to an existing folder): the route then opens a new session in that
 * folder for the task, the way `working_dir` opens a new chat there
 * (ATO-731). This is how the desktop's "Run overnight" (ATO-1113) runs a
 * task in the folder the person picked. `notify: "telegram"` reports the
 * terminal outcome to the paired owner, as `task create --notify telegram`
 * does. Fields this route does not know are ignored.
 *
 * `maxAttempts` defaults to `config.tasks.maxAttempts` when omitted.
 * `maxCostUsd` / `maxDurationMs` are the task's own budget (the desktop
 * "Run overnight" dialog sets them); omitted or `null` leaves the
 * config ceiling in charge, anything else that is not a positive
 * number is a 400.
 * Auto-drain (when `tasks.runOnCreate` is enabled) is fire-and-forget;
 * the response always returns 201 with the freshly persisted row,
 * never the post-drain status.
 */
export function createCreateTaskHandler(): HttpHandler {
  return async (req, res, ctx) => {
    if (!ctx.runtime.config.tasks.enabled) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody<Record<string, unknown>>(req);
    } catch (err) {
      sendError(
        res,
        400,
        openaiError(err instanceof Error ? err.message : "invalid body"),
      );
      return;
    }
    const sessionId = body.sessionId;
    const userMessage = body.userMessage;
    const maxAttempts =
      typeof body.maxAttempts === "number"
        ? body.maxAttempts
        : ctx.runtime.config.tasks.maxAttempts;
    const maxSteps = typeof body.maxSteps === "number" ? body.maxSteps : null;
    const workingDirRaw = body.workingDir;
    const hasWorkingDir = workingDirRaw !== undefined && workingDirRaw !== null;
    if (
      typeof userMessage !== "string" ||
      (typeof sessionId !== "string" && !hasWorkingDir)
    ) {
      sendError(
        res,
        400,
        openaiError("sessionId and userMessage are required strings"),
      );
      return;
    }
    if (typeof sessionId === "string" && hasWorkingDir) {
      sendError(
        res,
        400,
        openaiError("send sessionId or workingDir, not both", "invalid_request_error", "workingDir"),
      );
      return;
    }
    const notifyRaw = body.notify;
    if (notifyRaw !== undefined && notifyRaw !== null && notifyRaw !== "telegram") {
      sendError(
        res,
        400,
        openaiError("notify only supports: telegram", "invalid_request_error", "notify"),
      );
      return;
    }
    let taskSessionId: string;
    let openedSessionId: string | null = null;
    if (typeof sessionId === "string") {
      taskSessionId = sessionId;
    } else {
      const dir = checkWorkingDir(workingDirRaw);
      if (!dir.ok) {
        sendError(res, 400, openaiError(dir.error, "invalid_request_error", "workingDir"));
        return;
      }
      // Saved before the task row: `runOnCreate` may drain at once and loads the session.
      // `persist: false` so no trace recorder opens here (the first turn opens it) and a
      // refused task leaves nothing behind once its row is deleted below.
      const fresh = ctx.runtime.createSession({ metadata: { source: "http-task" }, persist: false });
      ctx.runtime.sessionStore.save({ ...fresh, workingDir: dir.dir });
      taskSessionId = fresh.id;
      openedSessionId = fresh.id;
    }
    try {
      // Validate here as well as in the store so a string or other
      // non-number is a 400 instead of being silently dropped.
      const maxCostUsd = validateMaxCostUsd(
        body.maxCostUsd as number | null | undefined,
      );
      const maxDurationMs = validateMaxDurationMs(
        body.maxDurationMs as number | null | undefined,
      );
      const created = ctx.runtime.taskRunner.create({
        sessionId: taskSessionId,
        userMessage,
        origin: "http",
        maxAttempts,
        maxSteps,
        maxCostUsd,
        maxDurationMs,
        ...(notifyRaw === "telegram" ? { notify: "telegram" as const } : {}),
      });
      sendJson(res, 201, recordToJson(created));
    } catch (err) {
      // The session opened for this task has nothing in it; it does not outlive a refused task.
      if (openedSessionId) ctx.runtime.sessionStore.delete(openedSessionId);
      if (err instanceof TaskValidationError) {
        sendError(
          res,
          400,
          openaiError(err.message, "invalid_request_error", err.field),
        );
        return;
      }
      throw err;
    }
  };
}

/**
 * `GET /api/tasks` — list tasks with optional `?session=`, `?status=`,
 * `?limit=` filters. `status` accepts a comma-separated list. Default
 * limit is 50, capped at 500 to bound the response size.
 */
export function createListTasksHandler(): HttpHandler {
  return async (req, res, ctx) => {
    if (!ctx.runtime.config.tasks.enabled) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionId = url.searchParams.get("session");
    const statusParam = url.searchParams.get("status");
    const limitParam = url.searchParams.get("limit");
    let limit = 50;
    if (limitParam !== null) {
      const parsed = Number.parseInt(limitParam, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        sendError(res, 400, openaiError("limit must be a positive integer"));
        return;
      }
      limit = Math.min(parsed, 500);
    }
    const status = parseStatusParam(statusParam);
    if (status === "invalid") {
      sendError(res, 400, openaiError(`unknown task status: ${statusParam}`));
      return;
    }
    const tasks = ctx.runtime.taskStore.list({
      ...(sessionId ? { sessionId } : {}),
      ...(status ? { status } : {}),
      limit,
    });
    sendJson(res, 200, { tasks: tasks.map(recordToJson) });
  };
}

/**
 * `GET /api/tasks/:id` — fetch a single task record. 404 when the row
 * is unknown.
 */
export function createGetTaskHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    if (!ctx.runtime.config.tasks.enabled) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      return;
    }
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("task id is required"));
      return;
    }
    const record = ctx.runtime.taskStore.get(id);
    if (!record) {
      sendError(res, 404, openaiError(`task not found: ${id}`));
      return;
    }
    sendJson(res, 200, recordToJson(record));
  };
}

/**
 * `DELETE /api/tasks/:id` — cancel the task. Idempotent on already-
 * terminal rows: returns the existing record unchanged. 404 when the
 * row is unknown so callers can distinguish "missing" from "already
 * cancelled". A task this agent is running has its turn stopped too
 * (`TaskRunner.cancel`); the row used to say `cancelled` while the turn
 * went on to its end.
 */
export function createCancelTaskHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    if (!ctx.runtime.config.tasks.enabled) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      return;
    }
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("task id is required"));
      return;
    }
    const cancelled = ctx.runtime.taskRunner.cancel(id);
    if (!cancelled) {
      sendError(res, 404, openaiError(`task not found: ${id}`));
      return;
    }
    sendJson(res, 200, recordToJson(cancelled));
  };
}

/**
 * `POST /api/tasks/:id/run` — execute one attempt of a single task.
 * Resolves with the post-attempt record (which may be `pending` again
 * if the attempt was retryable but more attempts remain). A `paused`
 * task runs too and is `paused` again after the run (ATO-590).
 */
export function createRunTaskHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    if (!ctx.runtime.config.tasks.enabled) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      return;
    }
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("task id is required"));
      return;
    }
    const existing = ctx.runtime.taskStore.get(id);
    if (!existing) {
      sendError(res, 404, openaiError(`task not found: ${id}`));
      return;
    }
    try {
      // "Run now": a paused task runs this once and stays paused (ATO-590).
      const result = await ctx.runtime.taskRunner.runOne(id, undefined, {
        evenIfPaused: true,
      });
      sendJson(res, 200, {
        task: result ? recordToJson(result) : null,
      });
    } catch (err) {
      if (err instanceof TaskStateError) {
        sendError(res, 409, openaiError(err.message));
        return;
      }
      throw err;
    }
  };
}

/**
 * `POST /api/tasks/drain` — drain every pending task. Optional
 * `?session=` query restricts the drain to one session. Resolves once
 * all in-scope work has settled into a non-`pending` state (or hit
 * the per-task max-attempt budget).
 */
export function createDrainTasksHandler(): HttpHandler {
  return async (req, res, ctx) => {
    if (!ctx.runtime.config.tasks.enabled) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionId = url.searchParams.get("session");
    const outcome = await ctx.runtime.taskRunner.drainPending(
      sessionId ? { sessionId } : {},
    );
    sendJson(res, 200, outcome);
  };
}

function parseStatusParam(
  raw: string | null,
): TaskStatus[] | undefined | "invalid" {
  if (raw === null || raw === "") return undefined;
  const allowed: TaskStatus[] = [
    "pending",
    "running",
    "paused",
    "completed",
    "failed",
    "blocked",
    "cancelled",
  ];
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const part of parts) {
    if (!allowed.includes(part as TaskStatus)) return "invalid";
  }
  return parts as TaskStatus[];
}

export function recordToJson(record: TaskRecord): Record<string, unknown> {
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
    notify: record.notify,
    maxCostUsd: record.maxCostUsd,
    maxDurationMs: record.maxDurationMs,
    spentUsd: record.spentUsd,
    stopCause: record.stopCause,
  };
}
