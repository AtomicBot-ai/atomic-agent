import type { DownloadJob } from "./download-jobs.js";

/**
 * A `running` record older than this has a worker that stopped writing:
 * the worker heartbeats every 30s even while it waits for the network,
 * so ten missed beats is not a slow disk. Readers treat such a job as
 * interrupted after a grace period of their own — a laptop waking from
 * sleep shows a stale record for a moment before the worker's next beat.
 */
export const STALE_RUNNING_MS = 5 * 60 * 1_000;

/**
 * A `running` record nobody has written for `STALE_RUNNING_MS`. The pid
 * may still answer — after a reboot the number can belong to anything —
 * but the worker that owned this job is not reporting.
 */
export function isDownloadJobStale(
  job: DownloadJob,
  now: number = Date.now(),
  thresholdMs: number = STALE_RUNNING_MS,
): boolean {
  if (job.status !== "running") return false;
  const updated = Date.parse(job.updatedAt);
  if (!Number.isFinite(updated)) return true;
  return now - updated > thresholdMs;
}

/** Milliseconds since the record was last written; `0` when unparsable. */
export function downloadJobSilenceMs(job: DownloadJob, now: number = Date.now()): number {
  const updated = Date.parse(job.updatedAt);
  return Number.isFinite(updated) ? Math.max(0, now - updated) : 0;
}
