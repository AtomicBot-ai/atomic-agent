import {
  applyLogbookAction,
  clearLogbookDays,
  deleteLogbookEntries,
  isDayKey,
  parseDaySpec,
  readLogbookDay,
  applyLogbookPreferences,
  hasPreferences,
  INDICATOR_TTL_MS,
  logbookPlatformSupport,
  parseLogbookAction,
  parseLogbookPreferences,
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
 *    ATO-2526: also `intervalMinutes`, `retentionDays`, `excludeApps`,
 *    `titleOnlyApps` and `standupAt` (`HH:MM` or null), beside or
 *    instead of an action (`logbook-preferences.ts`).
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
    const fields = (body !== null && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const prefs = parseLogbookPreferences(fields);
    if (!prefs.ok) {
      sendError(res, 400, openaiError(prefs.message, "invalid_request_error", prefs.field));
      return;
    }
    // An action, preferences, or both; a body with neither is a bad action.
    const wantsAction = fields.action !== undefined || !hasPreferences(fields);
    const action = wantsAction ? parseLogbookAction(body) : null;
    if (wantsAction && !action) {
      sendError(res, 400, openaiError("action must be start, stop, pause (minutes 1 to 1440) or resume", "invalid_request_error", "action"));
      return;
    }
    const dir = stateDir(ctx);
    const now = Date.now();
    let next = applyLogbookPreferences(readLogbookSettings(dir), prefs.preferences);
    if (action) {
      const result = applyLogbookAction(next, action, now, logbookPlatformSupport(platform));
      if (!result.ok) {
        sendError(res, 409, openaiError(result.message, "invalid_request_error", "action", "logbook_action_refused"));
        return;
      }
      next = result.settings;
    }
    writeLogbookSettings(dir, next);
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

/**
 * ATO-2526, the desktop's day timeline:
 *  - `GET    /api/logbook/day?day=today|yesterday|YYYY-MM-DD` answers `{ day, entries }`, oldest first;
 *  - `DELETE /api/logbook/entries` `{ day, at: [...] }` deletes those notes, `{ day, all: true }` the whole day;
 *    answers `{ removed }`.
 */
export function createLogbookDayHandler(): HttpHandler {
  return (req, res, ctx) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let day: string;
    try {
      day = parseDaySpec(url.searchParams.get("day") ?? "today", new Date());
    } catch (err) {
      sendError(res, 400, openaiError(err instanceof Error ? err.message : "bad day", "invalid_request_error", "day"));
      return;
    }
    sendJson(res, 200, { day, entries: readLogbookDay(stateDir(ctx), day) });
  };
}

export function createDeleteLogbookEntriesHandler(): HttpHandler {
  return async (req, res, ctx) => {
    if (refuseDevice(res, ctx)) return;
    let body: Record<string, unknown>;
    try {
      body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
    } catch {
      sendError(res, 400, openaiError("body must be JSON"));
      return;
    }
    const day = typeof body.day === "string" && isDayKey(body.day) ? body.day : null;
    if (!day) {
      sendError(res, 400, openaiError("day must be a date like 2026-11-27", "invalid_request_error", "day"));
      return;
    }
    if (body.all === true) {
      const before = readLogbookDay(stateDir(ctx), day).length;
      clearLogbookDays(stateDir(ctx), { day });
      sendJson(res, 200, { removed: before });
      return;
    }
    const ats = Array.isArray(body.at) ? body.at.filter((v): v is string => typeof v === "string").slice(0, 2_000) : [];
    if (ats.length === 0) {
      sendError(res, 400, openaiError("at must list the notes to delete, or all must be true", "invalid_request_error", "at"));
      return;
    }
    sendJson(res, 200, { removed: deleteLogbookEntries(stateDir(ctx), day, ats) });
  };
}
