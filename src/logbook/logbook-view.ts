import { logbookDir, readLogbookSettings, type LogbookSettings } from "./logbook-settings.js";
import { readLogbookStatus, type LogbookStatus } from "./logbook-status.js";
import { dayKey, listLogbookDays, readLogbookDay } from "./logbook-store.js";

/**
 * What the logbook looks like from outside (ATO-2534): the state the
 * desktop's `● Logbook` chip and menu bar icon draw, the settings and
 * the loop's last outcome. One shape for `GET /api/logbook` and every
 * answer of `PATCH /api/logbook/settings`, so a click and a poll draw
 * the same thing.
 */
export type LogbookState = "off" | "on" | "paused";

export interface LogbookPlatformSupport {
  supported: boolean;
  /** Why not, in plain words; `null` when supported. */
  reason: string | null;
}

export interface LogbookView {
  state: LogbookState;
  settings: LogbookSettings;
  last: LogbookStatus;
  days: string[];
  notesToday: number;
  folder: string;
  platform: LogbookPlatformSupport;
}

export const UNSUPPORTED_PLATFORM_REASON =
  "The logbook works on macOS only for now: it needs the front-app check that keeps password and login windows out.";

/** Whether this computer can run the logbook. */
export function logbookPlatformSupport(platform: NodeJS.Platform): LogbookPlatformSupport {
  return platform === "darwin" ? { supported: true, reason: null } : { supported: false, reason: UNSUPPORTED_PLATFORM_REASON };
}

export function logbookState(settings: LogbookSettings, now: number): LogbookState {
  if (!settings.enabled) return "off";
  return settings.pausedUntil !== null && now < settings.pausedUntil ? "paused" : "on";
}

export function readLogbookView(stateDir: string, now: Date, platform: NodeJS.Platform): LogbookView {
  const settings = readLogbookSettings(stateDir);
  return {
    state: logbookState(settings, now.getTime()),
    settings,
    last: readLogbookStatus(stateDir),
    days: listLogbookDays(stateDir),
    notesToday: readLogbookDay(stateDir, dayKey(now)).length,
    folder: logbookDir(stateDir),
    platform: logbookPlatformSupport(platform),
  };
}
