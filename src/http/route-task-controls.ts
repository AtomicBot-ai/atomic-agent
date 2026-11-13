import { openaiError } from "./openai-errors.js";
import { sendError, sendJson, type HttpHandler } from "./request-context.js";
import { recordToJson } from "./route-tasks.js";
import {
  TaskStateError,
  TaskValidationError,
  type TaskRecord,
  type TaskRunRecord,
} from "../tasks/index.js";

/**
 * Schedule controls for one task (ATO-590): pause, resume and the run
 * history the desktop's Tasks tab shows. An agent from before these
 * routes answers 404 "no route"; the desktop then hides the controls.
 */

/**
 * `POST /api/tasks/:id/pause` — `pending` -> `paused`; the scheduler
 * skips it until resumed. 200 with the record (also for a task already
 * paused), 404 unknown, 409 when the task is running or has ended.
 */
export function createPauseTaskHandler(): HttpHandler {
  return transitionHandler((store, id) => store.pause(id));
}

/**
 * `POST /api/tasks/:id/resume` — `paused` -> `pending`. A recurring task
 * is armed for its next firing from now (firings missed while paused are
 * skipped). 200 with the record (also for a task already pending), 404
 * unknown, 409 when the task is running or has ended.
 */
export function createResumeTaskHandler(): HttpHandler {
  return transitionHandler((store, id) => store.resume(id));
}

/**
 * `GET /api/tasks/:id/runs?limit=N` — the task's past runs, newest first:
 * `{ runs: [{ id, attempt, sessionId, startedAt, endedAt, outcome,
 * error, errorCategory }], available }`. `available: false` when this
 * agent could not keep a history on its tasks file (the list is then
 * empty). Default limit 50, capped at 200.
 */
export function createListTaskRunsHandler(): HttpHandler {
  return async (req, res, ctx) => {
    if (!ctx.runtime.config.tasks.enabled) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      return;
    }
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("task id is required"));
      return;
    }
    if (!ctx.runtime.taskStore.get(id)) {
      sendError(res, 404, openaiError(`task not found: ${id}`));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const limitParam = url.searchParams.get("limit");
    let limit = 50;
    if (limitParam !== null) {
      const parsed = Number.parseInt(limitParam, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        sendError(res, 400, openaiError("limit must be a positive integer"));
        return;
      }
      limit = Math.min(parsed, 200);
    }
    const store = ctx.runtime.taskStore;
    sendJson(res, 200, {
      runs: store.listRuns(id, limit).map(runToJson),
      available: store.runLogUnavailable === null,
    });
  };
}

type TaskStoreLike = {
  pause(id: string): TaskRecord | null;
  resume(id: string): TaskRecord | null;
};

function transitionHandler(
  apply: (store: TaskStoreLike, id: string) => TaskRecord | null,
): HttpHandler {
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
    try {
      const record = apply(ctx.runtime.taskStore, id);
      if (!record) {
        sendError(res, 404, openaiError(`task not found: ${id}`));
        return;
      }
      sendJson(res, 200, recordToJson(record));
    } catch (err) {
      if (err instanceof TaskStateError) {
        sendError(res, 409, openaiError(err.message));
        return;
      }
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

function runToJson(run: TaskRunRecord): Record<string, unknown> {
  return {
    id: run.id,
    attempt: run.attempt,
    sessionId: run.sessionId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    outcome: run.outcome,
    error: run.error,
    errorCategory: run.errorCategory,
  };
}
