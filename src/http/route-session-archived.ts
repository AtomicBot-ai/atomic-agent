import { readSessionArchived } from "../session/session-archived.js";
import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

/**
 * `POST /api/sessions/{id}/archived` — archive or unarchive a chat
 * (ATO-1150): `{ archived: true | false }`.
 *
 * The flag is `metadata.archived` on the stored session (`session-archived.ts`),
 * in the shared state dir, so the desktop's sidebar and the terminal's rail
 * both read it. `archived` must be a boolean (`400` otherwise); `404` for a
 * session that is not stored. Allowed while a turn runs: the flag is
 * stamped, so the turn's own end cannot write the old value back.
 * `updatedAt` is not touched, so the chat keeps its place in the lists.
 * The answer is the stored flag, the same field `GET /api/sessions` lists.
 */
export function createSetSessionArchivedHandler(): HttpHandler {
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
    if (typeof body.archived !== "boolean") {
      sendError(res, 400, openaiError("archived must be true or false"));
      return;
    }
    const saved = ctx.runtime.sessionStore.setSessionArchived(id, body.archived);
    if (saved === null) {
      sendError(res, 404, openaiError(`session not found: ${id}`));
      return;
    }
    sendJson(res, 200, { id, archived: readSessionArchived(saved.metadata) });
  };
}
