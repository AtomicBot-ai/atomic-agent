import { openaiError } from "./openai-errors.js";
import { sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * `POST /v1/chat/completions/{completion_id}/cancel` — abort a
 * streaming completion in flight. Mirrors hermes-agent
 * `handle_cancel_completion`. Non-streaming completions are tracked
 * implicitly via the request's `AbortController` and will stop when
 * the client disconnects, so they do not appear in the registry.
 */
export function createCancelCompletionHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const completionId = ctx.params.completion_id;
    if (!completionId) {
      sendError(res, 400, openaiError("completion_id is required"));
      return;
    }
    const cancelled = ctx.completionRegistry.cancel(completionId);
    if (!cancelled) {
      sendJson(res, 404, { status: "not_found" });
      return;
    }
    sendJson(res, 200, { status: "cancelled" });
  };
}
