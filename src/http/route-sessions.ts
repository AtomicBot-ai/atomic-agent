import { openaiError } from "./openai-errors.js";
import { sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * `GET /api/sessions` — list recent sessions in the current working
 * directory. `limit` (query string) caps the number of rows, default
 * 25, max 200. Payload mirrors `SessionState` minus the heavy
 * transcript by default — callers fetch the full state via
 * `/api/sessions/{id}` when they need it.
 */
export function createListSessionsHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const rawLimit = url.searchParams.get("limit");
    let limit = 25;
    if (rawLimit !== null) {
      const parsed = Number.parseInt(rawLimit, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        sendError(res, 400, openaiError("limit must be a positive integer"));
        return;
      }
      limit = Math.min(parsed, 200);
    }
    const workingDir = ctx.runtime.capabilities.workingDir;
    const sessions = ctx.runtime.sessionStore.listByWorkingDir(
      workingDir,
      limit,
    );
    sendJson(res, 200, {
      sessions: sessions.map((s) => ({
        id: s.id,
        workingDir: s.workingDir,
        status: s.status,
        turnCount: s.turnCount,
        stepCount: s.stepCount,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        lastError: s.lastError,
      })),
    });
  };
}

/**
 * `GET /api/sessions/{id}` — return the full `SessionState`, including
 * the transcript. 404 if the session is not persisted.
 */
export function createGetSessionHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("session id is required"));
      return;
    }
    const state = ctx.runtime.sessionStore.load(id);
    if (!state) {
      sendError(res, 404, openaiError(`session not found: ${id}`));
      return;
    }
    sendJson(res, 200, state);
  };
}

/**
 * `DELETE /api/sessions/{id}` — purge the session row. Idempotent:
 * returns 200 whether or not the row existed so orchestrators can
 * blindly retry.
 */
export function createDeleteSessionHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("session id is required"));
      return;
    }
    ctx.runtime.sessionStore.delete(id);
    sendJson(res, 200, { deleted: true, id });
  };
}
