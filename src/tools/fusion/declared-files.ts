import { readFile, stat } from "node:fs/promises";

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
  /** Declared paths that exist and were written during the task. */
  modified: string[];
  /**
   * Declared paths written during the task whose content is not a file
   * but a stand-in for one: a placeholder ("...", "<full file content>")
   * or a whole file collapsed onto one line with literal `\n` escapes.
   * Each is also in `modified`. Absent when there are none (ATO-883).
   */
  degenerate?: DegenerateFile[];
  /** Declared paths written during the task that are now empty. A note only: an empty file can be intended. */
  emptied?: string[];
}

export interface DegenerateFile {
  path: string;
  /** What the content is, as the error states it: "is only the placeholder \"...\"". */
  reason: string;
}

/**
 * Only files this small are read for a placeholder. A placeholder is a
 * few characters; reading every declared output whole to find one would
 * cost more than the check is worth.
 */
export const PLACEHOLDER_MAX_BYTES = 256;

/**
 * The collapsed-file check reads at most this much. A file written with
 * escaped newlines is a source file (tens of KB), never a large asset.
 */
export const ESCAPED_FILE_MAX_BYTES = 512 * 1024;

/**
 * What a worker writes when it means "the rest of the file goes here":
 * seen in one benchmark as a 367-line file overwritten 3 seconds later
 * with "...", then with "<full file content>", and reported `ok`.
 * Matched against the WHOLE trimmed content, so a real file that merely
 * contains "..." is never caught.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  // "...", "…", "[...]", "(...)", "// ...", "# ...", "/* ... */"
  /^(?:\/\/|#|\/\*|<!--)?\s*[[(]?\s*(?:\.{2,}|…+)\s*[\])]?\s*(?:\*\/|-->)?$/,
  // "<full file content>", "<file contents here>", "<rest of the code>"
  /^<\s*[a-z _.-]*\b(?:content|contents|file|code|here|placeholder|omitted|unchanged)\b[a-z _.-]*>$/i,
  // "{full file content}", "[file content]"
  /^[[{]\s*[a-z _.-]*\b(?:content|contents|file|code|placeholder)\b[a-z _.-]*[\]}]$/i,
];

/**
 * A whole source file written as one line with literal `\n` sequences —
 * a worker that passed escaped text to the write call. Measured: a
 * worker wrote `workshop.js` this way (one line, literal `\n`s) and
 * replied "written successfully". A minified file is also one line, but
 * carries a literal `\n` only inside the odd string; this needs many,
 * densely spaced.
 */
const MIN_ESCAPED_NEWLINES = 5;
const MAX_CHARS_PER_ESCAPED_NEWLINE = 200;

/**
 * Why `content` is a stand-in for a file rather than a file, or
 * `undefined` when it is a file (or simply empty — see `emptied`).
 * Pure; exported for the tests.
 */
export function describeDegenerateContent(content: string): string | undefined {
  const trimmed = content.trim();
  if (trimmed.length === 0) return undefined;
  if (
    trimmed.length <= PLACEHOLDER_MAX_BYTES &&
    PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed))
  ) {
    return `is only the placeholder ${JSON.stringify(trimmed)}`;
  }
  if (!trimmed.includes("\n")) {
    const escaped = trimmed.split("\\n").length - 1;
    if (
      escaped >= MIN_ESCAPED_NEWLINES &&
      escaped * MAX_CHARS_PER_ESCAPED_NEWLINE >= trimmed.length
    ) {
      return `is one line with ${escaped} literal \\n sequences: the content was written escaped`;
    }
  }
  return undefined;
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
  const report: DeclaredFileReport = { missing: [], unchanged: [], modified: [] };
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
      } else {
        report.modified.push(file);
        if (info.isFile() && info.size <= ESCAPED_FILE_MAX_BYTES) {
          await inspectWrittenContent(file, absolute, report);
        }
      }
    } catch (error) {
      if (isNotFound(error)) report.missing.push(file);
    }
  }
  return report;
}

/**
 * Read a file the task wrote and record it when it is empty or a
 * stand-in. A read that fails proves nothing and is skipped, like a
 * stat that fails for a reason other than absence.
 */
async function inspectWrittenContent(
  file: string,
  absolute: string,
  report: DeclaredFileReport,
): Promise<void> {
  let content: string;
  try {
    content = await readFile(absolute, "utf8");
  } catch {
    return;
  }
  if (content.trim().length === 0) {
    (report.emptied ??= []).push(file);
    return;
  }
  const reason = describeDegenerateContent(content);
  if (reason !== undefined) {
    (report.degenerate ??= []).push({ path: file, reason });
  }
}

/**
 * A reply that says nothing: empty, or only a placeholder. Measured: a
 * worker that had just overwritten its file with "..." replied "..."
 * and the task came back `ok`.
 */
export function isPlaceholderReply(reply: string): boolean {
  const trimmed = reply.trim();
  if (trimmed.length === 0) return true;
  return (
    trimmed.length <= PLACEHOLDER_MAX_BYTES &&
    PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed))
  );
}

/**
 * Fold a report into a result row.
 *
 *  - `ok` with a missing path becomes `failed`, with the absence as the
 *    error — the reply claimed something the disk contradicts.
 *  - Any other surviving status (`max_steps`, `needs_orchestrator`)
 *    already says the work is incomplete; the absence is added as a note
 *    so the status keeps saying *why* (out of steps, needs a wider scope).
 *  - A declared file the task left as a placeholder or as one escaped
 *    line (`degenerate`) is treated like a missing one: the file the
 *    reply stands on is not there (ATO-883).
 *  - Unchanged and emptied paths are always a note, never a status
 *    change; so is an `ok` reply that says nothing ("...", empty), since
 *    the files themselves passed.
 */
export function applyDeclaredFileReport(
  result: WorkerTaskResult,
  report: DeclaredFileReport,
): WorkerTaskResult {
  const degenerate = report.degenerate ?? [];
  const emptied = report.emptied ?? [];
  const silentReply = result.status === "ok" && isPlaceholderReply(result.reply);
  if (
    report.missing.length === 0 &&
    report.unchanged.length === 0 &&
    degenerate.length === 0 &&
    emptied.length === 0 &&
    !silentReply
  ) {
    return result;
  }
  const notes = [...(result.notes ?? [])];
  let status = result.status;
  let error = result.error;
  const contradictions = [
    ...report.missing.map(
      (path) => `declared file ${path} does not exist after the task`,
    ),
    ...degenerate.map(
      ({ path, reason }) => `declared file ${path} ${reason}`,
    ),
  ];
  if (contradictions.length > 0) {
    const absence = contradictions.join("; ");
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
  if (emptied.length > 0) {
    notes.push(`${emptied.join(", ")} empty after this task`);
  }
  if (silentReply && status === "ok") {
    notes.push(
      "the worker's reply is empty or a placeholder: it reported nothing, so check its files before relying on them",
    );
  }
  return {
    ...result,
    status,
    ...(error === undefined ? {} : { error }),
    ...(notes.length === 0 ? {} : { notes }),
  };
}

/**
 * An `ok` task that declared `files`, made no successful write, edit
 * or patch call, and changed none of those files on disk is
 * `no_changes` — the truthful name for "I'm done!" over an untouched
 * tree, which used to pass for `ok`.
 *
 * Both halves are needed. The call count alone would misread a worker
 * that wrote through the shell (the disk shows the change); the disk
 * alone would misread a task whose declared paths are all globs (there
 * is nothing to stat). A task with no declared `files` — research, a
 * review — is never `no_changes`; the caller only asks for tasks that
 * declared some. Statuses other than `ok` already say why the work is
 * incomplete and are left alone.
 */
export function applyNoChangesRule(
  result: WorkerTaskResult,
  report: DeclaredFileReport,
): WorkerTaskResult {
  if (result.status !== "ok") return result;
  if (result.tools.writes > 0 || report.modified.length > 0) return result;
  return {
    ...result,
    status: "no_changes",
    notes: [
      ...(result.notes ?? []),
      "no write, edit or patch call succeeded and no declared file changed",
    ],
  };
}
