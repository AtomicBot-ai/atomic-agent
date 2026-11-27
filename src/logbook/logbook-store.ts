import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureLogbookDir, logbookDir, readLogbookSettings } from "./logbook-settings.js";

/**
 * Observations, one JSON line each, in one file per local day:
 * `<stateDir>/logbook/YYYY-MM-DD.jsonl` (owner-only). Plain files on
 * purpose: the person can read, copy or delete a day without the agent,
 * and retention is deleting whole files. No screenshot is ever stored
 * here, only the short text the local model wrote about it.
 */
export interface LogbookEntry {
  /** ISO time of the capture. */
  at: string;
  /** Front app name and bundle id when the screenshot was taken. */
  app: string | null;
  bundleId: string | null;
  /** What the local model said the person was doing. */
  text: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function isDayKey(value: string): boolean {
  return DAY_RE.test(value);
}

/** Local calendar day of `date` as `YYYY-MM-DD`. */
export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `dayKey` of the local day `offset` days from `now` (negative is the past). */
export function dayKeyOffset(now: Date, offset: number): string {
  return dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
}

function dayFile(stateDir: string, day: string): string {
  if (!isDayKey(day)) throw new Error(`not a day: ${day} (use YYYY-MM-DD)`);
  return join(logbookDir(stateDir), `${day}.jsonl`);
}

export function appendLogbookEntry(stateDir: string, entry: LogbookEntry): void {
  ensureLogbookDir(stateDir);
  const day = dayKey(new Date(entry.at));
  appendFileSync(dayFile(stateDir, day), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function parseEntry(line: string): LogbookEntry | null {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (typeof o.at !== "string" || Number.isNaN(Date.parse(o.at)) || typeof o.text !== "string") return null;
    return {
      at: o.at,
      app: typeof o.app === "string" ? o.app : null,
      bundleId: typeof o.bundleId === "string" ? o.bundleId : null,
      text: o.text,
    };
  } catch {
    return null;
  }
}

/** One day's entries in file order; a broken line is skipped, a missing day is empty. */
export function readLogbookDay(stateDir: string, day: string): LogbookEntry[] {
  const file = dayFile(stateDir, day);
  if (!existsSync(file)) return [];
  const entries: LogbookEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = parseEntry(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Days that have a file, oldest first. */
export function listLogbookDays(stateDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(logbookDir(stateDir));
  } catch {
    return [];
  }
  return names
    .map((name) => DAY_FILE_RE.exec(name)?.[1])
    .filter((day): day is string => day !== undefined)
    .sort();
}

/** Delete day files older than the last `retentionDays` days (today counts as one). Returns the days removed. */
export function pruneLogbook(stateDir: string, retentionDays: number, now: Date): string[] {
  const keepFrom = dayKeyOffset(now, -(Math.max(1, Math.floor(retentionDays)) - 1));
  return removeDays(stateDir, listLogbookDays(stateDir).filter((day) => day < keepFrom));
}

export type LogbookClearScope =
  | { all: true }
  | { day: string }
  | { before: string };

/** Delete whole days. Returns the days removed. */
export function clearLogbookDays(stateDir: string, scope: LogbookClearScope): string[] {
  const days = listLogbookDays(stateDir);
  if ("all" in scope) return removeDays(stateDir, days);
  if ("day" in scope) {
    dayFile(stateDir, scope.day); // validates the key
    return removeDays(stateDir, days.filter((day) => day === scope.day));
  }
  if (!isDayKey(scope.before)) throw new Error(`not a day: ${scope.before} (use YYYY-MM-DD)`);
  return removeDays(stateDir, days.filter((day) => day < scope.before));
}

/**
 * Delete the entries of one day whose local time of day is in
 * `[fromMinute, toMinute)` (minutes after midnight). Returns how many
 * were removed. The day file is rewritten through a rename, and removed
 * when nothing is left.
 */
export function clearLogbookRange(stateDir: string, day: string, fromMinute: number, toMinute: number): number {
  const file = dayFile(stateDir, day);
  const entries = readLogbookDay(stateDir, day);
  const kept = entries.filter((entry) => {
    const minute = minuteOfDay(new Date(entry.at));
    return minute < fromMinute || minute >= toMinute;
  });
  return rewriteDay(file, entries.length, kept);
}

/**
 * Delete the entries of one day whose `at` is in `ats` (ATO-2526, the
 * desktop timeline's delete). Returns how many were removed; the file
 * is rewritten through a rename, and removed when nothing is left.
 */
export function deleteLogbookEntries(stateDir: string, day: string, ats: readonly string[]): number {
  const file = dayFile(stateDir, day);
  const drop = new Set(ats);
  const entries = readLogbookDay(stateDir, day);
  const kept = entries.filter((entry) => !drop.has(entry.at));
  return rewriteDay(file, entries.length, kept);
}

function rewriteDay(file: string, before: number, kept: readonly LogbookEntry[]): number {
  const removed = before - kept.length;
  if (removed === 0) return 0;
  if (kept.length === 0) {
    rmSync(file, { force: true });
    return removed;
  }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, kept.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
  renameSync(temp, file);
  return removed;
}

export function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Whether `logbook.query` belongs in the prompt: the logbook is on, or
 * notes from an earlier run are still kept. Read on every descriptor
 * check, so it is two small file-system calls.
 */
export function logbookToolOffered(stateDir: string): boolean {
  try {
    return readLogbookSettings(stateDir).enabled || listLogbookDays(stateDir).length > 0;
  } catch {
    return false;
  }
}

function removeDays(stateDir: string, days: readonly string[]): string[] {
  for (const day of days) rmSync(dayFile(stateDir, day), { force: true });
  return [...days];
}
