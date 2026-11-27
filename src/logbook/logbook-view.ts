import { linuxSessionKind } from "../tools/os/screen/screen-capture-win-linux.js";
import { NO_DISPLAY_REASON, WAYLAND_REASON } from "./logbook-front-window-linux.js";
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

export const UNSUPPORTED_PLATFORM_REASON = "The logbook works on macOS, Windows and Linux (X11) only.";

/**
 * Whether this computer can run the logbook (ATO-2526): macOS and
 * Windows always; Linux only in an X11 session, since Wayland lets no
 * program see which window is in front (the reason says what to do).
 */
export function logbookPlatformSupport(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): LogbookPlatformSupport {
  if (platform === "darwin" || platform === "win32") return { supported: true, reason: null };
  if (platform !== "linux") return { supported: false, reason: UNSUPPORTED_PLATFORM_REASON };
  const kind = linuxSessionKind(env);
  if (kind === "wayland") return { supported: false, reason: WAYLAND_REASON };
  if (kind === "none") return { supported: false, reason: NO_DISPLAY_REASON };
  return { supported: true, reason: null };
}

export function logbookState(settings: LogbookSettings, now: number): LogbookState {
  if (!settings.enabled) return "off";
  return settings.pausedUntil !== null && now < settings.pausedUntil ? "paused" : "on";
}

export function readLogbookView(stateDir: string, now: Date, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): LogbookView {
  const settings = readLogbookSettings(stateDir);
  return {
    state: logbookState(settings, now.getTime()),
    settings,
    last: readLogbookStatus(stateDir),
    days: listLogbookDays(stateDir),
    notesToday: readLogbookDay(stateDir, dayKey(now)).length,
    folder: logbookDir(stateDir),
    platform: logbookPlatformSupport(platform, env),
  };
}
