import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureLogbookDir, logbookDir } from "./logbook-settings.js";

/**
 * What the capture loop last did, in `<stateDir>/logbook/status.json`.
 * Written only by the loop (the scheduler leader), read by
 * `logbook status`; kept apart from settings.json so the CLI and the
 * loop never overwrite each other's file.
 */
export const LOGBOOK_STATUS_FILE = "status.json";

export type LogbookOutcome = "captured" | "skipped" | "error";

export interface LogbookStatus {
  lastAttemptAt: number | null;
  lastCaptureAt: number | null;
  lastOutcome: LogbookOutcome | null;
  /** Why the last attempt skipped or failed, in plain words. */
  lastReason: string | null;
  /** The local provider that described the last capture. */
  provider: string | null;
}

export const EMPTY_LOGBOOK_STATUS: Readonly<LogbookStatus> = Object.freeze({
  lastAttemptAt: null,
  lastCaptureAt: null,
  lastOutcome: null,
  lastReason: null,
  provider: null,
});

const OUTCOMES: readonly string[] = ["captured", "skipped", "error"];

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 500) : null;
}

export function parseLogbookStatus(raw: unknown): LogbookStatus {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_LOGBOOK_STATUS };
  const o = raw as Record<string, unknown>;
  return {
    lastAttemptAt: num(o.lastAttemptAt),
    lastCaptureAt: num(o.lastCaptureAt),
    lastOutcome: typeof o.lastOutcome === "string" && OUTCOMES.includes(o.lastOutcome) ? (o.lastOutcome as LogbookOutcome) : null,
    lastReason: str(o.lastReason),
    provider: str(o.provider),
  };
}

export function readLogbookStatus(stateDir: string): LogbookStatus {
  try {
    return parseLogbookStatus(JSON.parse(readFileSync(join(logbookDir(stateDir), LOGBOOK_STATUS_FILE), "utf8")));
  } catch {
    return { ...EMPTY_LOGBOOK_STATUS };
  }
}

export function writeLogbookStatus(stateDir: string, status: LogbookStatus): void {
  const dir = ensureLogbookDir(stateDir);
  const target = join(dir, LOGBOOK_STATUS_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}
