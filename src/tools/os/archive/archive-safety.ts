import { resolve, sep } from "node:path";
import type { ExtractLimits } from "./archive-types.js";

/**
 * Path-sanitiser for archive entries. Every archive format stores entry
 * names as strings; a malicious archive can put `../../../etc/passwd`
 * (zip-slip) or an absolute path in there. This helper is the single
 * choke-point that every backend MUST funnel entries through before
 * materialising them on disk.
 */
export interface SanitizedPath {
  /** Entry path with normalised separators and no leading/trailing slashes. */
  normalised: string;
  /** Absolute path on disk where the entry may be written. */
  absolute: string;
}

export type SanitizationError =
  | { reason: "absolute_path" }
  | { reason: "backslash_in_path" }
  | { reason: "empty_path" }
  | { reason: "traversal_escapes_dest" }
  | { reason: "null_byte" };

/**
 * Normalise and vet an archive entry path against `destDir`.
 *
 * Rules:
 *  - An empty string or `.` is rejected ("empty_path").
 *  - A leading `/` or `C:\\` is rejected ("absolute_path"). Archives commonly
 *    carry paths like `/etc/hosts` which we refuse to touch on the host.
 *  - `\\` is rejected inside entry names ("backslash_in_path"). Legitimate
 *    archives use forward slashes; backslashes are almost always a
 *    Windows-path-injection attempt.
 *  - A null byte anywhere in the path is rejected ("null_byte"), guarding
 *    against C-string truncation tricks on older fs calls.
 *  - After `path.resolve(destDir, normalised)`, the resolved absolute path
 *    MUST start with `destDir + sep` (or equal destDir itself). Otherwise
 *    "traversal_escapes_dest".
 */
export function sanitizeEntryPath(
  destDir: string,
  rawPath: string,
): { ok: true; value: SanitizedPath } | { ok: false; error: SanitizationError } {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { ok: false, error: { reason: "empty_path" } };
  }
  if (rawPath.includes("\0")) {
    return { ok: false, error: { reason: "null_byte" } };
  }
  if (rawPath.includes("\\")) {
    return { ok: false, error: { reason: "backslash_in_path" } };
  }
  if (rawPath.startsWith("/") || /^[A-Za-z]:/.test(rawPath)) {
    return { ok: false, error: { reason: "absolute_path" } };
  }
  // Strip trailing `/` (common for directory entries); drop `./` prefix.
  let normalised = rawPath.replace(/\/+$/, "");
  if (normalised.startsWith("./")) normalised = normalised.slice(2);
  if (normalised === "." || normalised.length === 0) {
    return { ok: false, error: { reason: "empty_path" } };
  }

  const destAbs = resolve(destDir);
  const candidate = resolve(destAbs, normalised);
  if (candidate !== destAbs && !candidate.startsWith(destAbs + sep)) {
    return { ok: false, error: { reason: "traversal_escapes_dest" } };
  }
  return {
    ok: true,
    value: { normalised, absolute: candidate },
  };
}

/**
 * Running budget counter. Each backend creates one per extract call and
 * calls `charge(...)` before writing each entry; if `ok` is false the
 * caller must skip the entry and record the reason in the report.
 */
export class ExtractBudget {
  private entryCount = 0;
  private totalBytes = 0;

  constructor(private readonly limits: ExtractLimits) {}

  chargeEntry(size: number): BudgetDecision {
    if (this.entryCount >= this.limits.maxEntries) {
      return { ok: false, reason: `max_entries_exceeded (${this.limits.maxEntries})` };
    }
    if (size > this.limits.maxEntryBytes) {
      return {
        ok: false,
        reason: `entry_exceeds_max_entry_bytes (${size} > ${this.limits.maxEntryBytes})`,
      };
    }
    if (this.totalBytes + size > this.limits.maxTotalBytes) {
      return {
        ok: false,
        reason: `total_bytes_exceeds_cap (${this.totalBytes + size} > ${this.limits.maxTotalBytes})`,
      };
    }
    this.entryCount++;
    this.totalBytes += size;
    return { ok: true };
  }

  get snapshot(): { entryCount: number; totalBytes: number } {
    return { entryCount: this.entryCount, totalBytes: this.totalBytes };
  }
}

export type BudgetDecision =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Describe a sanitisation failure in a single human-readable string that is
 * safe to surface to the agent (and eventually the user).
 */
export function describeSanitizationError(
  rawPath: string,
  err: SanitizationError,
): string {
  const p = JSON.stringify(rawPath);
  switch (err.reason) {
    case "absolute_path":
      return `skipped ${p}: absolute paths are not allowed`;
    case "backslash_in_path":
      return `skipped ${p}: backslashes are not allowed inside archive entries`;
    case "empty_path":
      return `skipped ${p}: entry path is empty or resolves to destDir`;
    case "traversal_escapes_dest":
      return `skipped ${p}: entry would escape the destination directory`;
    case "null_byte":
      return `skipped ${p}: path contains a NUL byte`;
  }
}
