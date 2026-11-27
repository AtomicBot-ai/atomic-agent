import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import { listingResultCaps } from "../../../compressor/listing-caps.js";
import { headOfCommand, unknownJob, type ShellJobCallContext } from "./shell-job-calls.js";
import {
  JobMonitor,
  MONITOR_COOLDOWN_MS,
  MONITOR_MAX_WAKES,
} from "./shell-job-monitor.js";
import { hasUntil } from "./shell-job-until.js";
import { compileWatchPattern } from "./shell-job-watch.js";

/**
 * `{"monitor": id, "until": "ready|error"}` (ATO-2436): put a monitor on
 * a running job and return at once; matching lines reach the session
 * later as notices (`shell-job-monitor.ts`). `{"monitor": id}` with no
 * pattern turns it off. The job becomes kept, since a monitor on a job
 * that dies at the turn's end would never say anything.
 */
export function runShellMonitor(
  ctx: ShellJobCallContext,
  id: number,
  rawUntil: unknown,
): CompressedToolResult {
  const record = ctx.jobs.get(ctx.sessionId, id);
  if (!record) return unknownJob(ctx, id);
  const command = headOfCommand(record.facts.commandLine);
  if (!hasUntil(rawUntil)) {
    const had = record.monitor?.active === true;
    ctx.jobs.setMonitor(record, undefined);
    return ok(
      had
        ? `the monitor on job ${id} (${command}) is off; the job keeps running`
        : `job ${id} (${command}) had no monitor; pass "until" to set one, e.g. {"monitor": ${id}, "until": "ready|error"}`,
      { jobId: id, monitor: null },
    );
  }
  if (record.state !== "running") {
    return error(
      `job ${id} (${command}) is not running any more; {"wait": ${id}} collects its output`,
      { jobId: id },
    );
  }
  const compiled = compileWatchPattern(rawUntil);
  if (!compiled.ok) return error(`os.shell.run: ${compiled.message}`, { jobId: id, invalidCall: true });
  if (!ctx.jobs.wake.canWake()) {
    return error(
      `monitors are not available here; use {"wait": ${id}, "until": ${JSON.stringify(rawUntil)}} to wait for the line in this turn`,
      { jobId: id },
    );
  }
  const until = rawUntil as string;
  ctx.jobs.markKeep(record);
  const monitor = new JobMonitor({
    sessionId: ctx.sessionId,
    jobId: id,
    command,
    until,
    pattern: compiled.pattern,
    job: record.job,
    deliver: (wake) => ctx.jobs.wake.deliver(wake),
    stillOwned: () => ctx.jobs.get(ctx.sessionId, id) === record && record.state !== "killed",
  });
  ctx.jobs.setMonitor(record, monitor);
  const cooldownSeconds = Math.round(MONITOR_COOLDOWN_MS / 1000);
  return ok(
    [
      `monitoring job ${id} (${command}) for lines matching ${JSON.stringify(until)}; the job is now kept.`,
      `When it prints one, a notice arrives in this conversation, also after this turn ends (at most one every ${cooldownSeconds} s, up to ${MONITOR_MAX_WAKES}; one more if the job exits on its own). Lines printed before now do not count.`,
      `Do not poll the job: carry on or end the turn. {"monitor": ${id}} turns the monitor off; {"kill": ${id}} stops the job.`,
    ].join("\n"),
    { jobId: id, monitor: { until } },
  );
}

/** Every line of these short results is the point: none may be cut. */
const RESULT_CAPS = listingResultCaps(3, 240);

function ok(output: string, details: Record<string, unknown>): CompressedToolResult {
  return compressToolResult({ tool: "os.shell.run", status: "ok", output, details }, RESULT_CAPS);
}

function error(output: string, details: Record<string, unknown>): CompressedToolResult {
  return compressToolResult({ tool: "os.shell.run", status: "error", output, details }, RESULT_CAPS);
}
