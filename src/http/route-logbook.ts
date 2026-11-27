import {
  applyLogbookAction,
  INDICATOR_TTL_MS,
  logbookPlatformSupport,
  parseLogbookAction,
  readLogbookSettings,
  readLogbookView,
  writeLogbookIndicator,
  writeLogbookSettings,
} from "../logbook/index.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HandlerContext, type HttpHandler } from "./request-context.js";

/**
 * The logbook for a frontend (ATO-2534), so the desktop can show the
 * `● Logbook` chip and menu bar icon and let the person pause or stop it
 * without a terminal:
 *
 *  - `GET   /api/logbook` the state (`off`, `on`, `paused`), settings,
 *    last outcome, kept days and whether this computer can run it.
 *  - `PATCH /api/logbook/settings` `{action: "start"|"stop"|"pause"|"resume", minutes?}`:
 *    the same changes as `atomic-agent logbook start|stop|pause|resume`;
 *    answers the new state. `409` with a plain sentence when the change
 *    cannot apply (start on an unsupported computer, pause while off).
 *  - `POST  /api/logbook/indicator` `{visible, away?}`: the frontend's
 *    report that its mark is on screen (`logbook-indicator.ts`). Only
 *    then does this process capture; a report holds `ttlMs`.
 *
 * Settings live in `<stateDir>/logbook/settings.json`, like the CLI's.
 * A paired phone may read the state but neither change it nor claim a
 * mark on this computer's screen.
 */
function stateDir(ctx: HandlerContext): string {
  return ctx.runtime.config.paths.stateDir;
}

function refuseDevice(res: Parameters<HttpHandler>[1], ctx: HandlerContext): boolean {
  if (!ctx.pairedDevice) return false;
  sendJson(res, 403, openaiError("The logbook is changed only on this computer", "permission_error", null, "device_cannot_change_logbook"));
  return true;
}

export function createLogbookStatusHandler(platform: NodeJS.Platform = process.platform): HttpHandler {
  return (_req, res, ctx) => {
    sendJson(res, 200, readLogbookView(stateDir(ctx), new Date(), platform));
  };
}

export function createLogbookSettingsHandler(platform: NodeJS.Platform = process.platform): HttpHandler {
  return async (req, res, ctx) => {
    if (refuseDevice(res, ctx)) return;
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendError(res, 400, openaiError("body must be JSON"));
      return;
    }
    const action = parseLogbookAction(body);
    if (!action) {
      sendError(res, 400, openaiError("action must be start, stop, pause (minutes 1 to 1440) or resume", "invalid_request_error", "action"));
      return;
    }
    const dir = stateDir(ctx);
    const now = Date.now();
    const result = applyLogbookAction(readLogbookSettings(dir), action, now, logbookPlatformSupport(platform));
    if (!result.ok) {
      sendError(res, 409, openaiError(result.message, "invalid_request_error", "action", "logbook_action_refused"));
      return;
    }
    writeLogbookSettings(dir, result.settings);
    sendJson(res, 200, readLogbookView(dir, new Date(now), platform));
  };
}

export function createLogbookIndicatorHandler(): HttpHandler {
  return async (req, res, ctx) => {
    if (refuseDevice(res, ctx)) return;
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendError(res, 400, openaiError("body must be JSON"));
      return;
    }
    const o = (body ?? {}) as Record<string, unknown>;
    if (typeof o.visible !== "boolean") {
      sendError(res, 400, openaiError("visible must be true or false", "invalid_request_error", "visible"));
      return;
    }
    const written = writeLogbookIndicator(stateDir(ctx), { visible: o.visible, away: o.away === true });
    sendJson(res, 200, { visible: written !== null, away: written?.away ?? false, ttlMs: INDICATOR_TTL_MS });
  };
}
