import { readSessionTrashed } from "../session/session-trashed.js";
import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

/**
 * `POST /api/sessions/{id}/trashed`: move a chat to the desktop's Trash or
 * out of it (ATO-2332): `{ trashed: true | false }`.
 *
 * The flag is `metadata.trashed` on the stored session (`session-trashed.ts`).
 * While it is set, `memory.sessions.search` and its hit read leave the chat
 * out, as they would a deleted one; the desktop deletes it for good after
 * 30 days in Trash. `trashed` must be a boolean (`400` otherwise); `404` for
 * a session that is not stored. `updatedAt` is not touched.
 */
export function createSetSessionTrashedHandler(): HttpHandler {
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
    if (typeof body.trashed !== "boolean") {
      sendError(res, 400, openaiError("trashed must be true or false"));
      return;
    }
    const saved = ctx.runtime.sessionStore.setSessionTrashed(id, body.trashed);
    if (saved === null) {
      sendError(res, 404, openaiError(`session not found: ${id}`));
      return;
    }
    sendJson(res, 200, { id, trashed: readSessionTrashed(saved.metadata) });
  };
}
