import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

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
 * `POST /api/sessions/{id}/steer` — fold `{ text }` into the turn
 * already running on that session.
 *
 * This is NOT a way to send a message: it never starts a turn and never
 * queues behind one (see §"Mid-turn steering" in AGENTS.md). When the
 * session is idle there is nothing to steer, and the caller is told so
 * with `409` rather than having the message silently disappear — the
 * correct follow-up is `POST /v1/chat/completions`. `429` means the
 * per-session steering inbox is full; the turn has not read any of them
 * yet, so piling on more would only bloat one prompt.
 */
export function createSteerSessionHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("session id is required"));
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
    const text = body.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      sendError(res, 400, openaiError("text must be a non-empty string"));
      return;
    }
    if (!ctx.runtime.turnController.isBusy(id)) {
      sendError(
        res,
        409,
        openaiError(
          `session ${id} has no turn in flight — send the message with POST /v1/chat/completions instead`,
        ),
      );
      return;
    }
    if (!ctx.runtime.steer(id, text)) {
      sendError(
        res,
        429,
        openaiError(
          `steering inbox for session ${id} is full — the running turn has not consumed the pending messages yet`,
        ),
      );
      return;
    }
    sendJson(res, 200, { steered: true, sessionId: id });
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
