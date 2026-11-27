import { clampInterval, clampRetention, type LogbookSettings } from "./logbook-settings.js";
import type { LogbookPlatformSupport } from "./logbook-view.js";

/**
 * The switch's verbs for a frontend (ATO-2534), the same changes the
 * CLI's `start`, `stop`, `pause` and `resume` write: the desktop's chip,
 * its menu bar icon and `PATCH /api/logbook/settings` all go through
 * here. Pure: the caller reads and writes settings.json.
 */
export type LogbookAction =
  | { kind: "start"; intervalMinutes?: number; retentionDays?: number }
  | { kind: "stop" }
  | { kind: "pause"; minutes: number }
  | { kind: "resume" };

export const DEFAULT_PAUSE_MINUTES = 60;
export const MAX_PAUSE_MINUTES = 24 * 60;

export type LogbookActionResult =
  | { ok: true; settings: LogbookSettings }
  | { ok: false; message: string };

/** A request body into an action; `null` when it names none or a bad value. */
export function parseLogbookAction(body: unknown): LogbookAction | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  switch (o.action) {
    case "start":
      return {
        kind: "start",
        ...(typeof o.intervalMinutes === "number" ? { intervalMinutes: o.intervalMinutes } : {}),
        ...(typeof o.retentionDays === "number" ? { retentionDays: o.retentionDays } : {}),
      };
    case "stop":
      return { kind: "stop" };
    case "resume":
      return { kind: "resume" };
    case "pause": {
      const minutes = o.minutes === undefined ? DEFAULT_PAUSE_MINUTES : o.minutes;
      if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_PAUSE_MINUTES) return null;
      return { kind: "pause", minutes: Math.round(minutes) };
    }
    default:
      return null;
  }
}

export function applyLogbookAction(
  settings: LogbookSettings,
  action: LogbookAction,
  now: number,
  platform: LogbookPlatformSupport,
): LogbookActionResult {
  switch (action.kind) {
    case "start":
      if (!platform.supported) return { ok: false, message: platform.reason ?? "The logbook does not work on this computer." };
      return {
        ok: true,
        settings: {
          ...settings,
          enabled: true,
          pausedUntil: null,
          intervalMinutes: action.intervalMinutes === undefined ? settings.intervalMinutes : clampInterval(action.intervalMinutes),
          retentionDays: action.retentionDays === undefined ? settings.retentionDays : clampRetention(action.retentionDays),
        },
      };
    case "stop":
      return { ok: true, settings: { ...settings, enabled: false, pausedUntil: null } };
    case "pause":
      if (!settings.enabled) return { ok: false, message: "The logbook is off, so there is nothing to pause." };
      return { ok: true, settings: { ...settings, pausedUntil: now + action.minutes * 60_000 } };
    case "resume":
      return { ok: true, settings: { ...settings, pausedUntil: null } };
  }
}
