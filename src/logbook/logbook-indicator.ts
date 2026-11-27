import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureLogbookDir, logbookDir } from "./logbook-settings.js";

/**
 * The visible-mark signal (ATO-2534). A process whose own frontend is
 * not the TUI (the desktop's `atag serve`) captures only while that
 * frontend says it is showing the `● Logbook` chip or the menu bar
 * icon. The frontend says so with `POST /api/logbook/indicator`, every
 * few seconds while the mark is on screen; the route writes this file
 * with the serve process's own pid and a short expiry. So:
 *
 * - a window that closes, crashes or stops reporting stops capture
 *   within `INDICATOR_TTL_MS`, without having to say anything;
 * - the mark one app shows never lets another process capture: the
 *   pid must be the reader's own.
 *
 * `away` is the frontend's word that the person is idle or the screen
 * is locked (Electron's powerMonitor), so nothing worth a note is on it.
 * Precedent: macOS shows its own dot while the screen is recorded, and
 * Screenpipe and Rewind keep a menu bar icon for as long as they record.
 */
export const LOGBOOK_INDICATOR_FILE = "indicator.json";
/** How long one report holds. The desktop reports every 15 s. */
export const INDICATOR_TTL_MS = 45_000;

export interface LogbookIndicator {
  /** The process that received the report (the one allowed to capture). */
  pid: number;
  /** Epoch ms after which the mark counts as gone. */
  visibleUntil: number;
  /** The person is idle or the screen is locked. */
  away: boolean;
}

export type IndicatorState = "visible" | "away" | "hidden";

export function parseLogbookIndicator(raw: unknown): LogbookIndicator | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const pid = o.pid;
  const until = o.visibleUntil;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof until !== "number" || !Number.isFinite(until)) return null;
  return { pid, visibleUntil: until, away: o.away === true };
}

export function readLogbookIndicator(stateDir: string): LogbookIndicator | null {
  try {
    return parseLogbookIndicator(JSON.parse(readFileSync(join(logbookDir(stateDir), LOGBOOK_INDICATOR_FILE), "utf8")));
  } catch {
    return null;
  }
}

/**
 * Record one report from the frontend. `visible: false` removes the
 * file, so capture stops on the next tick instead of at the expiry.
 */
export function writeLogbookIndicator(
  stateDir: string,
  report: { visible: boolean; away?: boolean },
  pid: number = process.pid,
  now: number = Date.now(),
): LogbookIndicator | null {
  const dir = ensureLogbookDir(stateDir);
  const target = join(dir, LOGBOOK_INDICATOR_FILE);
  if (!report.visible) {
    rmSync(target, { force: true });
    return null;
  }
  const next: LogbookIndicator = { pid, visibleUntil: now + INDICATOR_TTL_MS, away: report.away === true };
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  renameSync(temp, target);
  return next;
}

/** What the mark looks like to process `pid` at `now`. */
export function indicatorState(indicator: LogbookIndicator | null, pid: number, now: number): IndicatorState {
  if (!indicator || indicator.pid !== pid || now >= indicator.visibleUntil) return "hidden";
  return indicator.away ? "away" : "visible";
}
