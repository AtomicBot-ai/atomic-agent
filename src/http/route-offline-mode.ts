import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * `GET /api/offline-mode` and `POST /api/offline-mode` (ATO-1084, the
 * contract the desktop's Settings › Privacy row reads, ATO-1087).
 *
 * GET answers `{ enabled, egress }`; POST takes `{ enabled: boolean }`,
 * persists `network.offline`, applies it at once and answers the same
 * shape. `egress` is the process's outbound counter: bytes and requests
 * sent to hosts other than this machine, and attempts offline mode
 * refused, since `egress.since`.
 */
export function createGetOfflineModeHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const control = ctx.runtime.offlineMode;
    if (!control) {
      sendError(res, 501, openaiError("offline mode is not available in this runtime"));
      return;
    }
    sendJson(res, 200, { enabled: control.isEnabled(), egress: control.egress() });
  };
}

export function createSetOfflineModeHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const control = ctx.runtime.offlineMode;
    if (!control) {
      sendError(res, 501, openaiError("offline mode is not available in this runtime"));
      return;
    }
    let body: { enabled?: unknown };
    try {
      body = await readJsonBody<{ enabled?: unknown }>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (typeof body.enabled !== "boolean") {
      sendError(res, 400, openaiError("enabled must be a boolean", "invalid_request_error", "enabled"));
      return;
    }
    try {
      await control.setEnabled(body.enabled);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, openaiError(`could not switch offline mode: ${message}`, "server_error"));
      return;
    }
    sendJson(res, 200, { enabled: control.isEnabled(), egress: control.egress() });
  };
}
