import { checkShellSecretValue, SHELL_SECRET_CATEGORY } from "../approval/shell-secret.js";

import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

interface SecretBody {
  approvalId?: unknown;
  /** What the person typed into the masked field. */
  value?: unknown;
  /** True: the person closed the field without typing. */
  skip?: unknown;
}

/**
 * `POST /api/shell/secret`: answer a password an interactive shell job
 * asks for (ATO-2486). The request reaches the client as an ordinary
 * `approval_request` on `GET /api/events` with `category:
 * "shell_secret_input"` and a `secretInput` object (`jobId`, `label`,
 * `commandLine`, `promptLine`), replayed on reconnect like any pending
 * approval.
 *
 * Body: `{ approvalId, value }`, or `{ approvalId, skip: true }`. The
 * value goes into the job's input and nowhere else: the reply never
 * echoes it, an error never names it. A paired device (a phone) is
 * refused with `403`: the password is typed on this computer. `400` for
 * a request that is not a secret or a value it cannot take (empty, more
 * than one line, too long), and the request stays open; `404` once it
 * is no longer pending.
 */
export function createShellSecretHandler(): HttpHandler {
  return async (req, res, ctx) => {
    if (ctx.pairedDevice) {
      sendJson(res, 403, openaiError(
        "A paired device cannot type a password into a job; type it on this computer, or skip it",
        "permission_error",
        null,
        "device_cannot_send_secret",
      ));
      return;
    }
    let body: SecretBody;
    try {
      body = await readJsonBody<SecretBody>(req);
    } catch {
      // The parser's message may quote the body, and the body is a password.
      sendError(res, 400, openaiError("Invalid JSON"));
      return;
    }
    const approvalId = body.approvalId;
    if (typeof approvalId !== "string" || approvalId.length === 0) {
      sendError(res, 400, openaiError("approvalId is required"));
      return;
    }
    const request = ctx.runtime.approvals.pendingRequest(approvalId);
    if (request === null) {
      ctx.approvalBus.resolved(approvalId);
      sendError(res, 404, openaiError(`approvalId not pending: ${approvalId}`));
      return;
    }
    if (request.category !== SHELL_SECRET_CATEGORY || request.secretInput === undefined) {
      sendError(
        res,
        400,
        openaiError("not a secret input; answer it with POST /api/approval/resolve"),
      );
      return;
    }
    if (body.skip === true) {
      ctx.runtime.approvals.resolve({ approvalId, approved: false });
      ctx.approvalBus.resolved(approvalId);
      sendJson(res, 200, { resolved: true, approvalId, skipped: true });
      return;
    }
    const checked = checkShellSecretValue(body.value);
    if (!checked.ok) {
      sendError(res, 400, openaiError(checked.reason));
      return;
    }
    const resolved = ctx.runtime.approvals.resolve({ approvalId, approved: true, secret: checked.value });
    ctx.approvalBus.resolved(approvalId);
    if (!resolved) {
      sendError(res, 404, openaiError(`approvalId not pending: ${approvalId}`));
      return;
    }
    sendJson(res, 200, { resolved: true, approvalId, typed: true });
  };
}
