import {
  cancelTask,
  createTask,
  drainTasks,
  getTask,
  listTasks,
  parseTaskStatusFilter,
  runTask,
  serializeTask,
} from "../runtime-api/index.js";

import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";
import { sendRuntimeApiError } from "./runtime-api-http.js";

/**
 * `POST /api/tasks` — persist a new task. Body shape:
 *
 *  ```json
 *  { "sessionId": "s-…", "userMessage": "…", "maxAttempts": 3, "maxSteps": 10 }
 *  ```
 *
 * `maxAttempts` defaults to `config.tasks.maxAttempts` when omitted.
 * Delegates to the shared runtime-facade so the sidecar and HTTP stay in
 * lockstep.
 */
export function createCreateTaskHandler(): HttpHandler {
  return async (req, res, ctx) => {
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
    if (typeof body.sessionId !== "string") {
      sendError(res, 400, openaiError("sessionId is required"));
      return;
    }
    try {
      const created = createTask(ctx.runtime, {
        sessionId: body.sessionId,
        userMessage: typeof body.userMessage === "string" ? body.userMessage : "",
        origin: "http",
        ...(typeof body.maxAttempts === "number"
          ? { maxAttempts: body.maxAttempts }
          : {}),
        maxSteps: typeof body.maxSteps === "number" ? body.maxSteps : null,
      });
      sendJson(res, 201, serializeTask(created));
    } catch (err) {
      if (sendRuntimeApiError(res, err)) return;
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
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionId = url.searchParams.get("session");
    const limitParam = url.searchParams.get("limit");
    let limit: number | undefined;
    if (limitParam !== null) {
      limit = Number.parseInt(limitParam, 10);
    }
    try {
      const status = parseTaskStatusFilter(url.searchParams.get("status"));
      const tasks = listTasks(ctx.runtime, {
        ...(sessionId ? { sessionId } : {}),
        ...(status ? { status } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      sendJson(res, 200, { tasks: tasks.map(serializeTask) });
    } catch (err) {
      if (sendRuntimeApiError(res, err)) return;
      throw err;
    }
  };
}

/**
 * `GET /api/tasks/:id` — fetch a single task record. 404 when the row
 * is unknown.
 */
export function createGetTaskHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("task id is required"));
      return;
    }
    try {
      sendJson(res, 200, serializeTask(getTask(ctx.runtime, id)));
    } catch (err) {
      if (sendRuntimeApiError(res, err)) return;
      throw err;
    }
  };
}

/**
 * `DELETE /api/tasks/:id` — cancel the task. Idempotent on already-
 * terminal rows: returns the existing record unchanged. 404 when the
 * row is unknown.
 */
export function createCancelTaskHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("task id is required"));
      return;
    }
    try {
      sendJson(res, 200, serializeTask(cancelTask(ctx.runtime, id)));
    } catch (err) {
      if (sendRuntimeApiError(res, err)) return;
      throw err;
    }
  };
}

/**
 * `POST /api/tasks/:id/run` — execute one attempt of a single task.
 * Resolves with the post-attempt record (which may be `pending` again
 * if the attempt was retryable but more attempts remain).
 */
export function createRunTaskHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("task id is required"));
      return;
    }
    try {
      const result = await runTask(ctx.runtime, id);
      sendJson(res, 200, { task: result ? serializeTask(result) : null });
    } catch (err) {
      if (sendRuntimeApiError(res, err)) return;
      throw err;
    }
  };
}

/**
 * `POST /api/tasks/drain` — drain every pending task. Optional
 * `?session=` query restricts the drain to one session.
 */
export function createDrainTasksHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionId = url.searchParams.get("session");
    try {
      const outcome = await drainTasks(
        ctx.runtime,
        sessionId ? { sessionId } : {},
      );
      sendJson(res, 200, outcome);
    } catch (err) {
      if (sendRuntimeApiError(res, err)) return;
      throw err;
    }
  };
}
