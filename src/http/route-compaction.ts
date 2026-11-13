import { SessionNotFoundError } from "../runtime/session-not-found-error.js";
import { compactionInstructionsError } from "../runtime/compaction-instructions.js";
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
        // Consume the body through the shared request-size limiter, even when it is empty.
        let body: unknown;
        try { body = await readJsonBody(req); }
        catch (error) { sendError(res, 400, openaiError(error instanceof Error ? error.message : "invalid body")); return; }
        // Optional `instructions` (ATO-661): what the summary must keep. Other bodies stay accepted, as before.
        const instructions = body !== null && typeof body === "object" && !Array.isArray(body)
          ? (body as { instructions?: unknown }).instructions : undefined;
        const invalid = compactionInstructionsError(instructions);
        if (invalid) { sendError(res, 400, openaiError(invalid, "invalid_request_error", "instructions")); return; }
        const result = await ctx.runtime.compactSession(id, {
          signal: controller.signal, ...(typeof instructions === "string" ? { instructions } : {}),
        });
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
