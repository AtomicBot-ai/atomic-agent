import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The logbook's own switch (ATO-2363), kept in `<stateDir>/logbook/settings.json`
 * rather than in config.json: turning it on or off needs no config
 * version bump, the CLI can write it while the agent runs, and the
 * scheduler sidecar re-reads it on every tick, so `logbook stop` takes
 * effect within one tick. Missing or broken means off.
 */
export const LOGBOOK_DIR = "logbook";
export const LOGBOOK_SETTINGS_FILE = "settings.json";

export const DEFAULT_INTERVAL_MINUTES = 5;
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 60;
export const DEFAULT_RETENTION_DAYS = 14;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 365;
/** Most extra apps a person can exclude; more is a typo, not a list. */
export const MAX_EXCLUDED_APPS = 50;

export interface LogbookSettings {
  enabled: boolean;
  /** Minutes between two screenshots. */
  intervalMinutes: number;
  /** Days of observations kept, today included; older day files are deleted. */
  retentionDays: number;
  /** Epoch ms until which nothing is captured, or `null` when not paused. */
  pausedUntil: number | null;
  /** Extra apps never captured: bundle ids (prefix match) or app names. */
  excludeApps: string[];
  /**
   * Apps noted by window title only (ATO-2526, "describe less"): no
   * screenshot and no model call, just the app and its window title.
   */
  titleOnlyApps: string[];
  /** Local time `HH:MM` the standup is written every morning, or `null` (off, the default). */
  standupAt: string | null;
}

export const DEFAULT_LOGBOOK_SETTINGS: Readonly<LogbookSettings> = Object.freeze({
  enabled: false,
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  retentionDays: DEFAULT_RETENTION_DAYS,
  pausedUntil: null,
  excludeApps: [],
  titleOnlyApps: [],
  standupAt: null,
});

const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `HH:MM` on a 24-hour clock. */
export function isStandupClock(value: unknown): value is string {
  return typeof value === "string" && CLOCK_RE.test(value);
}

function appList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter((v) => v.length > 0 && v.length <= 200)
        .slice(0, MAX_EXCLUDED_APPS)
    : [];
}

export function logbookDir(stateDir: string): string {
  return join(stateDir, LOGBOOK_DIR);
}

export function clampInterval(value: unknown): number {
  return clampInt(value, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES);
}

export function clampRetention(value: unknown): number {
  return clampInt(value, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Any JSON value into settings: unknown keys dropped, bad values defaulted. Never throws. */
export function parseLogbookSettings(raw: unknown): LogbookSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_LOGBOOK_SETTINGS, excludeApps: [], titleOnlyApps: [] };
  }
  const o = raw as Record<string, unknown>;
  const paused =
    typeof o.pausedUntil === "number" && Number.isFinite(o.pausedUntil) && o.pausedUntil > 0
      ? o.pausedUntil
      : null;
  return {
    enabled: o.enabled === true,
    intervalMinutes: clampInterval(o.intervalMinutes),
    retentionDays: clampRetention(o.retentionDays),
    pausedUntil: paused,
    excludeApps: appList(o.excludeApps),
    titleOnlyApps: appList(o.titleOnlyApps),
    standupAt: isStandupClock(o.standupAt) ? o.standupAt : null,
  };
}

export function readLogbookSettings(stateDir: string): LogbookSettings {
  try {
    return parseLogbookSettings(JSON.parse(readFileSync(join(logbookDir(stateDir), LOGBOOK_SETTINGS_FILE), "utf8")));
  } catch {
    return parseLogbookSettings(null);
  }
}

/** Write through a temp file and a rename, owner-only, so a reader never sees half a file. */
export function writeLogbookSettings(stateDir: string, settings: LogbookSettings): void {
  const dir = ensureLogbookDir(stateDir);
  const target = join(dir, LOGBOOK_SETTINGS_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(parseLogbookSettings(settings), null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

/** `<stateDir>/logbook`, created owner-only (0700) when missing. */
export function ensureLogbookDir(stateDir: string): string {
  const dir = logbookDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows has no POSIX modes; the per-user profile folder is private already.
  }
  return dir;
}

/** On, and not inside a pause. */
export function logbookCapturing(settings: LogbookSettings, now: number): boolean {
  if (!settings.enabled) return false;
  return settings.pausedUntil === null || now >= settings.pausedUntil;
}
