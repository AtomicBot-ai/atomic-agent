import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";
import type { PrivacyShieldControl } from "../runtime/runtime-contract.js";

/**
 * `GET /api/privacy-shield` and `POST /api/privacy-shield` (ATO-1082, the
 * contract the desktop's Settings › Privacy row reads). Same shape as
 * `/api/offline-mode`.
 *
 * GET answers `{ enabled, masked, sessions }`: whether Privacy Shield is
 * on, and how many distinct values (emails, phones, cards, IBANs, keys)
 * this agent process has masked before they went to a cloud model, over
 * how many chats. `?sessionId=<id>` adds `session: { masked, lastRequest }`
 * for that chat. POST takes `{ enabled: boolean }`, persists
 * `privacy.shield.enabled`, applies it to the next cloud request and
 * answers the same shape.
 */
function snapshot(control: PrivacyShieldControl, sessionId: string | null) {
  return { enabled: control.isEnabled(), ...control.stats(sessionId ?? undefined) };
}

function sessionIdOf(url: string | undefined): string | null {
  const id = new URL(url ?? "/", "http://localhost").searchParams.get("sessionId");
  return id && id.length > 0 ? id : null;
}

export function createGetPrivacyShieldHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const control = ctx.runtime.privacyShield;
    if (!control) {
      sendError(res, 501, openaiError("privacy shield is not available in this runtime"));
      return;
    }
    sendJson(res, 200, snapshot(control, sessionIdOf(req.url)));
  };
}

export function createSetPrivacyShieldHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const control = ctx.runtime.privacyShield;
    if (!control) {
      sendError(res, 501, openaiError("privacy shield is not available in this runtime"));
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
      sendError(res, 500, openaiError(`could not switch privacy shield: ${message}`, "server_error"));
      return;
    }
    sendJson(res, 200, snapshot(control, sessionIdOf(req.url)));
  };
}
