import {
  readSessionTitle,
  validateUserSessionTitle,
} from "../session/index.js";
import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

/**
 * `PATCH /api/sessions/{id}` — rename a session: `{ title }`.
 *
 * The title is trimmed and must be 1–120 characters on one line; it is
 * refused with `400` rather than repaired, so the name the client shows
 * is the name that was stored. `404` when the session is not persisted.
 *
 * The store stamps the title as the operator's (`renameSession`), so the
 * namer never replaces it and a turn that was already running when the
 * rename landed cannot write its older copy back over it. `updatedAt` is
 * not touched: the row keeps its place in the list. The answer carries
 * the stored title, the same field `GET /api/sessions` lists.
 */
export function createRenameSessionHandler(): HttpHandler {
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
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, openaiError("body must be a JSON object"));
      return;
    }
    const checked = validateUserSessionTitle(body.title);
    if (!checked.ok) {
      sendError(res, 400, openaiError(checked.error));
      return;
    }
    const renamed = ctx.runtime.sessionStore.renameSession(id, checked.title);
    if (renamed === null) {
      sendError(res, 404, openaiError(`session not found: ${id}`));
      return;
    }
    sendJson(res, 200, {
      id,
      title: readSessionTitle(renamed.metadata),
    });
  };
}
