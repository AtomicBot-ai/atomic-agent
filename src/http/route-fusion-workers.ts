import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

/**
 * The person's controls over one running fusion worker, for hosts that
 * draw the live worker rows (the desktop's subagent panel, ATO-568).
 * The TUI reaches the same three calls through `/worker`.
 *
 * Every route is addressed by the PARENT session (`{id}`, the chat the
 * fan-out runs in) and the task id (`{taskId}`, the id on the worker's
 * `atomic.fusion_worker` frames). A task id alone never reaches a
 * worker of another session: `runtime.fusionWorkers` keys on the pair.
 *
 * Nothing here starts, queues or retries work. A worker that is not
 * running is a 404 the host shows as such; it is not an error to retry.
 */

/**
 * `GET /api/sessions/{id}/fusion/workers` — the task ids of the
 * workers running right now under `{id}`'s fan-out, and the actions
 * this agent accepts on them. `actions` is how a host feature-detects:
 * an older agent has no route at all (404 with an unknown-route
 * body), and one with this route always lists what it supports.
 */
export function createListFusionWorkersHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("session id is required"));
      return;
    }
    sendJson(res, 200, {
      sessionId: id,
      running: ctx.runtime.fusionWorkers.running(id),
      actions: ["stop", "steer", "escalate"],
    });
  };
}

/**
 * `POST /api/sessions/{id}/fusion/workers/{taskId}/stop` — cancel that
 * worker alone. The fan-out and the turn go on; the row ends as
 * `cancelled` with "stopped by the person". `200 {stopped:true}`, or
 * `404` when no such worker is running (already finished, or never).
 */
export function createStopFusionWorkerHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const { id, taskId } = ctx.params;
    if (!id || !taskId) {
      sendError(res, 400, openaiError("session id and task id are required"));
      return;
    }
    if (!ctx.runtime.fusionWorkers.stop(id, taskId)) {
      sendError(res, 404, openaiError(`no fusion worker ${taskId} is running in session ${id}`));
      return;
    }
    sendJson(res, 200, { stopped: true, sessionId: id, taskId });
  };
}

/**
 * `POST /api/sessions/{id}/fusion/workers/{taskId}/steer` with
 * `{ text }` — queue the person's note for that worker alone. It is
 * read at the worker's next step boundary, like a session steer.
 * `200 {steered:true}` means queued; `404` the worker is not running;
 * `409` it is running but its turn no longer takes notes or its inbox
 * is full (nothing was queued; the note is the caller's to keep).
 */
export function createSteerFusionWorkerHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const { id, taskId } = ctx.params;
    if (!id || !taskId) {
      sendError(res, 400, openaiError("session id and task id are required"));
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody<Record<string, unknown>>(req);
    } catch (err) {
      sendError(res, 400, openaiError(err instanceof Error ? err.message : "invalid body"));
      return;
    }
    const text = body.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      sendError(res, 400, openaiError("text must be a non-empty string"));
      return;
    }
    if (ctx.runtime.fusionWorkers.steer(id, taskId, text)) {
      sendJson(res, 200, { steered: true, sessionId: id, taskId });
      return;
    }
    // `steer` already refused; this read only names the refusal.
    if (!ctx.runtime.fusionWorkers.running(id).includes(taskId)) {
      sendError(res, 404, openaiError(`no fusion worker ${taskId} is running in session ${id}`));
      return;
    }
    sendError(
      res,
      409,
      openaiError(
        `fusion worker ${taskId} is not taking notes right now — its turn is ending or its inbox is full`,
      ),
    );
  };
}

/**
 * `POST /api/sessions/{id}/fusion/workers/{taskId}/escalate` — ask the
 * configured escalation model to advise that worker. Resolves when the
 * advice is in (or refused) with the one line the TUI prints:
 * `200 {line}`, or `404` when the worker is not running.
 */
export function createEscalateFusionWorkerHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const { id, taskId } = ctx.params;
    if (!id || !taskId) {
      sendError(res, 400, openaiError("session id and task id are required"));
      return;
    }
    const line = await ctx.runtime.fusionWorkers.escalate(id, taskId);
    if (line === null) {
      sendError(res, 404, openaiError(`no fusion worker ${taskId} is running in session ${id}`));
      return;
    }
    sendJson(res, 200, { line, sessionId: id, taskId });
  };
}
