import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The launch's Atomic Core update check (main.ts watchCoreUpdates) and the
 * toast it may put up.
 *
 * Two rules, both from people seeing the same toast on every launch:
 *
 * - `requiresAgentUpdate` never toasts. It means a newer Core exists that this
 *   build of the agent does not support: the person cannot act on it, and the
 *   app's own update brings the agent (and the Core it supports) with it.
 * - A real `updateAvailable` toasts once per version. The version it was shown
 *   for is kept on disk (`<userData>/core-update-notice.json`), so the next
 *   launch, and the six-hourly check, stay quiet about it; a newer version
 *   toasts again.
 */
export interface CoreUpdateCheck {
  currentVersion: string | null;
  compatibleVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  requiresAgentUpdate: boolean;
}

/** The version a toast would be about, or null when there is nothing to say. */
export function coreUpdateNoticeVersion(check: CoreUpdateCheck | null | undefined, dismissed: string | null): string | null {
  if (!check || !check.updateAvailable) return null;
  /* Nothing installed yet is a fresh machine on the default engine, not an
     update: Core comes down with the first model start (or the installer
     placed it). */
  if (check.currentVersion === null) return null;
  const version = typeof check.compatibleVersion === "string" && check.compatibleVersion ? check.compatibleVersion : null;
  if (!version || version === check.currentVersion) return null;
  return version === dismissed ? null : version;
}

export function coreUpdateNoticePath(userData: string): string {
  return join(userData, "core-update-notice.json");
}

/** The version the person was last told about, or null. Never throws. */
export function readDismissedCoreUpdate(userData: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(coreUpdateNoticePath(userData), "utf8")) as { dismissed?: unknown }).dismissed;
    return typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Remember that `version` was shown (and so dismissed): written whole, via a temp file. Never throws. */
export function writeDismissedCoreUpdate(userData: string, version: string): boolean {
  const path = coreUpdateNoticePath(userData);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ dismissed: version }) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}
