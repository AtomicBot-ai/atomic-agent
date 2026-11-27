import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import { collect, renderShellDetached, unknownJob, type ShellJobCallContext } from "./shell-job-calls.js";
import type { ShellJobRecord } from "./shell-jobs.js";
import { compileWatchPattern, JobLineWatch } from "./shell-job-watch.js";
import {
  formatUntilElapsedNotice,
  formatUntilExitedNotice,
  renderShellLineMatched,
} from "./shell-job-until-result.js";
import { resolveShellTimeout } from "./shell-timeout.js";

/**
 * The `until` forms of `os.shell.run` (ATO-2358): `{cmd, until}` (from
 * shell.ts, after the guard and approval) and `{wait: id, until}`. Kept
 * apart from shell-job-calls.ts, which this builds on.
 */

/** Whether a call really passed `until` (a zero-filling model sends `""`). */
export function hasUntil(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "";
}

/**
 * `{wait: id, until}` (ATO-2358): return on the first unread line the
 * pattern matches, rather than only at the exit. Still running at the
 * wait's end, the job is given back as usual; it is never stopped here.
 */
export async function runShellWaitUntil(
  ctx: ShellJobCallContext,
  record: ShellJobRecord,
  rawUntil: unknown,
  timeoutMs: number,
): Promise<CompressedToolResult> {
  const compiled = compileWatchPattern(rawUntil);
  if (!compiled.ok) {
    return compressToolResult({
      tool: "os.shell.run",
      status: "error",
      output: `os.shell.run: ${compiled.message}`,
      details: { jobId: record.id, invalidCall: true },
    });
  }
  const until = rawUntil as string;
  record.lineWatch ??= new JobLineWatch(record.job);
  const startedAt = Date.now();
  const outcome = await record.lineWatch.waitForLine(compiled.pattern, timeoutMs, ctx.signal);
  if (outcome.kind === "matched") return renderShellLineMatched(record, until, outcome);
  if (outcome.kind === "exited" || record.state !== "running") {
    return collect(ctx.jobs, record, [formatUntilExitedNotice(until, outcome.dropped)]);
  }
  // Elapsed, or the turn was cancelled mid-wait: how long it really watched.
  const waitedMs = Date.now() - startedAt;
  return renderShellDetached(record, {
    waitedMs,
    again: true,
    defaultTimeoutMs: ctx.defaultTimeoutMs,
    detachNotice: formatUntilElapsedNotice(
      record.id,
      until,
      outcome.kind === "elapsed" ? timeoutMs : waitedMs,
      outcome.dropped,
    ),
  });
}

/** `{wait: id, until, timeoutMs?, keep?}`: the job by id, then the watch. */
export async function runShellWaitUntilById(
  ctx: ShellJobCallContext,
  id: number,
  rawUntil: unknown,
  rawTimeoutMs: unknown,
  keep: boolean,
): Promise<CompressedToolResult> {
  const record = ctx.jobs.get(ctx.sessionId, id);
  if (!record) return unknownJob(ctx, id);
  if (keep) ctx.jobs.markKeep(record);
  const timeout = resolveShellTimeout(rawTimeoutMs, ctx.defaultTimeoutMs);
  return runShellWaitUntil(ctx, record, rawUntil, timeout.timeoutMs);
}
