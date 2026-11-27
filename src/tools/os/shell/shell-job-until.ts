import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import {
  collect,
  headOfCommand,
  renderShellDetached,
  unknownJob,
  type ShellJobCallContext,
} from "./shell-job-calls.js";
import type { ShellJobRecord } from "./shell-jobs.js";
import { compileWatchPattern, JobLineWatch } from "./shell-job-watch.js";
import {
  formatUntilElapsedNotice,
  formatUntilExitedNotice,
  formatUntilMatchedThenExitedNotice,
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

/** What `{cmd, until}` carries into the result: the start call's notices and eviction. */
export interface UntilStartExtras {
  notices?: readonly string[];
  evicted?: ShellJobRecord | null;
  maxJobs?: number;
}

/** The same eviction line a plain detached result shows. */
function evictionNotice(extra: UntilStartExtras): string[] {
  const evicted = extra.evicted;
  if (!evicted) return [];
  const which = evicted.keep ? "job (kept ones included)" : "un-kept job";
  return [
    `job ${evicted.id} (${headOfCommand(evicted.facts.commandLine)}) was stopped to stay within ${extra.maxJobs ?? "the limit of"} running jobs — the oldest ${which}`,
  ];
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
  extra: UntilStartExtras = {},
): Promise<CompressedToolResult> {
  const startNotices = [...(extra.notices ?? []), ...evictionNotice(extra)];
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
  if (outcome.kind === "matched") {
    // The line came, but the job is gone too (its last lines are only
    // checked at the exit): report the exit, not a running job.
    if (record.job.exited() !== null || record.state !== "running") {
      return collect(ctx.jobs, record, [
        ...startNotices,
        formatUntilMatchedThenExitedNotice(until, outcome.line.text),
      ]);
    }
    return renderShellLineMatched(record, until, outcome, startNotices);
  }
  if (outcome.kind === "exited" || record.state !== "running") {
    return collect(ctx.jobs, record, [
      ...startNotices,
      formatUntilExitedNotice(until, outcome.dropped),
    ]);
  }
  // Elapsed, or the turn was cancelled mid-wait: how long it really watched.
  const waitedMs = Date.now() - startedAt;
  return renderShellDetached(record, {
    waitedMs,
    again: true,
    defaultTimeoutMs: ctx.defaultTimeoutMs,
    notices: extra.notices ?? [],
    evicted: extra.evicted ?? null,
    ...(extra.maxJobs === undefined ? {} : { maxJobs: extra.maxJobs }),
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
