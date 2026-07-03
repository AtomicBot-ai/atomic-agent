import {
  deleteSession,
  getSession,
  listSessions,
} from "../runtime-api/index.js";

import { openaiError } from "./openai-errors.js";
import { sendError, sendJson, type HttpHandler } from "./request-context.js";
import { sendRuntimeApiError } from "./runtime-api-http.js";

/**
 * `GET /api/sessions` — list recent sessions in the current working
 * directory. `limit` (query string) caps the number of rows, default
 * 25, max 200.
 */
export function createListSessionsHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const rawLimit = url.searchParams.get("limit");
    let limit: number | undefined;
    if (rawLimit !== null) {
      limit = Number.parseInt(rawLimit, 10);
    }
    const workingDir = ctx.runtime.capabilities.workingDir;
    try {
      const sessions = listSessions(ctx.runtime, {
        workingDir,
        ...(limit !== undefined ? { limit } : {}),
      });
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
    } catch (err) {
      if (sendRuntimeApiError(res, err)) return;
      throw err;
    }
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
    try {
      sendJson(res, 200, getSession(ctx.runtime, id));
    } catch (err) {
      if (sendRuntimeApiError(res, err)) return;
      throw err;
    }
  };
}

/**
 * `DELETE /api/sessions/{id}` — purge the session row. Idempotent:
 * returns 200 whether or not the row existed.
 */
export function createDeleteSessionHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("session id is required"));
      return;
    }
    deleteSession(ctx.runtime, id);
    sendJson(res, 200, { deleted: true, id });
  };
}
