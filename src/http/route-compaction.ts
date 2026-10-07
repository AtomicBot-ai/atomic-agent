import { SessionNotFoundError } from "../runtime/session-not-found-error.js";
import { openaiError } from "./openai-errors.js";
import { onClientGone, readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";

export function createSessionCompactionHandler(run: boolean): HttpHandler {
  return async (req, res, ctx) => {
    const id = ctx.params.id;
    if (!id) { sendError(res, 400, openaiError("session id is required")); return; }
    const controller = new AbortController();
    onClientGone(res, () => controller.abort());
    try {
      if (run) {
        // Consume even an unused body through the shared request-size limiter.
        try { await readJsonBody(req); }
        catch (error) { sendError(res, 400, openaiError(error instanceof Error ? error.message : "invalid body")); return; }
        const result = await ctx.runtime.compactSession(id, { signal: controller.signal });
        if (!res.destroyed) sendJson(res, result.status === "busy" ? 409 : 200, result);
      } else {
        sendJson(res, 200, { sessionId: id, compaction: ctx.runtime.getSessionCompaction(id) });
      }
    } catch (error) {
      if (!res.destroyed) sendError(res, error instanceof SessionNotFoundError ? 404 : 500,
        openaiError(error instanceof Error ? error.message : "compaction failed"));
    }
  };
}
