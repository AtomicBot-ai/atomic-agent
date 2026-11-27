import { isStandupClock, parseLogbookSettings, type LogbookSettings } from "./logbook-settings.js";

/**
 * The logbook's choices a frontend edits (ATO-2526, the desktop's
 * Settings, Logbook): how often, how long notes are kept, the apps never
 * captured, the apps noted by title only, and the morning standup time.
 * `PATCH /api/logbook/settings` takes them beside or instead of an
 * `action`. A field left out is kept; the result goes through the same
 * parse as settings.json, so it is clamped and cleaned the same way.
 */
export interface LogbookPreferences {
  intervalMinutes?: number;
  retentionDays?: number;
  excludeApps?: string[];
  titleOnlyApps?: string[];
  standupAt?: string | null;
}

export const PREFERENCE_KEYS = ["intervalMinutes", "retentionDays", "excludeApps", "titleOnlyApps", "standupAt"] as const;

export type ParsedPreferences = { ok: true; preferences: LogbookPreferences } | { ok: false; field: string; message: string };

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;
}

export function parseLogbookPreferences(body: Record<string, unknown>): ParsedPreferences {
  const out: LogbookPreferences = {};
  for (const key of ["intervalMinutes", "retentionDays"] as const) {
    if (body[key] === undefined) continue;
    const value = body[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, field: key, message: `${key} must be a number` };
    out[key] = value;
  }
  for (const key of ["excludeApps", "titleOnlyApps"] as const) {
    if (body[key] === undefined) continue;
    const list = stringList(body[key]);
    if (!list) return { ok: false, field: key, message: `${key} must be a list of app names` };
    out[key] = list;
  }
  if (body.standupAt !== undefined) {
    if (body.standupAt !== null && !isStandupClock(body.standupAt)) {
      return { ok: false, field: "standupAt", message: "standupAt must be a time like 09:00, or null to turn it off" };
    }
    out.standupAt = body.standupAt as string | null;
  }
  return { ok: true, preferences: out };
}

export function hasPreferences(body: Record<string, unknown>): boolean {
  return PREFERENCE_KEYS.some((key) => body[key] !== undefined);
}

export function applyLogbookPreferences(settings: LogbookSettings, preferences: LogbookPreferences): LogbookSettings {
  return parseLogbookSettings({ ...settings, ...preferences });
}
