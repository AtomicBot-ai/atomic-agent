import { stat } from "node:fs/promises";

import { resolveUserPath } from "../os/expand-home.js";
import type { WorkerTaskResult } from "./worker-result.js";

/**
 * Ground truth for a worker's claims about the files its task names.
 *
 * A worker's reply is a model's account of what it did, and three times
 * in one benchmark a worker replied "Implemented `js/scene.js` …" —
 * once with invented tool results written out as text — while the file
 * did not exist. `fusion.delegate` reported `ok`, and the orchestrator
 * then spent ~24 minutes re-verifying. The disk is cheap to ask.
 *
 * `task.files` mixes outputs with inputs ("paths the worker should start
 * from"), and nothing says which is which. So only an ABSENT path is
 * fatal — neither an input nor an output may be missing after a task
 * that says it succeeded — and a path that exists but was not touched
 * is only a note, because for an input that is exactly right.
 */
export interface DeclaredFileReport {
  /** Declared paths that do not exist after the task. */
  missing: string[];
  /** Declared paths that exist but were not modified during the task. */
  unchanged: string[];
}

/** Globs are patterns, not paths: whether they "exist" is meaningless. */
const GLOB_CHARS = /[*?[\]{}]/;

/**
 * Filesystem mtime resolution slack. Some filesystems store whole
 * (FAT: two) seconds, so a file written in the first moments of a task
 * can carry an mtime just before the task's recorded start.
 */
export const MTIME_SLACK_MS = 2000;

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Stat each declared path (resolved against `workingDir`, as the worker's
 * tools resolve it). Never throws: a path that cannot be resolved or
 * stat'ed for any reason other than absence proves nothing either way
 * and is skipped.
 */
export async function inspectDeclaredFiles(
  files: readonly string[],
  workingDir: string,
  startedAt: number,
): Promise<DeclaredFileReport> {
  const report: DeclaredFileReport = { missing: [], unchanged: [] };
  for (const file of files) {
    if (GLOB_CHARS.test(file)) continue;
    let absolute: string;
    try {
      absolute = resolveUserPath(file, workingDir);
    } catch {
      continue;
    }
    try {
      const info = await stat(absolute);
      if (info.mtimeMs < startedAt - MTIME_SLACK_MS) {
        report.unchanged.push(file);
      }
    } catch (error) {
      if (isNotFound(error)) report.missing.push(file);
    }
  }
  return report;
}

/**
 * Fold a report into a result row.
 *
 *  - `ok` with a missing path becomes `failed`, with the absence as the
 *    error — the reply claimed something the disk contradicts.
 *  - Any other surviving status (`max_steps`, `needs_orchestrator`)
 *    already says the work is incomplete; the absence is added as a note
 *    so the status keeps saying *why* (out of steps, needs a wider scope).
 *  - Unchanged paths are always a note, never a status change.
 */
export function applyDeclaredFileReport(
  result: WorkerTaskResult,
  report: DeclaredFileReport,
): WorkerTaskResult {
  if (report.missing.length === 0 && report.unchanged.length === 0) {
    return result;
  }
  const notes = [...(result.notes ?? [])];
  let status = result.status;
  let error = result.error;
  if (report.missing.length > 0) {
    const absence = report.missing
      .map((path) => `declared file ${path} does not exist after the task`)
      .join("; ");
    if (status === "ok") {
      status = "failed";
      error = error === undefined ? absence : `${absence}; ${error}`;
    } else {
      notes.push(absence);
    }
  }
  if (report.unchanged.length > 0) {
    notes.push(`${report.unchanged.join(", ")} unchanged by this task`);
  }
  return {
    ...result,
    status,
    ...(error === undefined ? {} : { error }),
    ...(notes.length === 0 ? {} : { notes }),
  };
}
