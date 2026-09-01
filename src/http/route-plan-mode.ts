import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * `GET /api/plan-mode` and `POST /api/plan-mode` — read and set the
 * runtime's plan-mode switch.
 *
 * Plan mode is session state, not config: "a look but do not touch that
 * survived a restart would be a mystery rather than a memory"
 * (bootstrap.ts). That is exactly why it needs a route — a client that
 * only speaks HTTP had no way to reach `runtime.setPlanMode`, so the TUI
 * was the only surface that could offer the mode at all.
 *
 * The runtime reads the flag through a getter on every tool call
 * (`isPlanMode: () => planMode`), so a POST takes effect at the next
 * step rather than the next process.
 */
export function createGetPlanModeHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    sendJson(res, 200, { planMode: ctx.runtime.getPlanMode() });
  };
}

export function createSetPlanModeHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: { enabled?: unknown };
    try {
      body = await readJsonBody<{ enabled?: unknown }>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (typeof body.enabled !== "boolean") {
      sendError(res, 400, openaiError("enabled must be a boolean"));
      return;
    }
    ctx.runtime.setPlanMode(body.enabled);
    sendJson(res, 200, { planMode: ctx.runtime.getPlanMode() });
  };
}
