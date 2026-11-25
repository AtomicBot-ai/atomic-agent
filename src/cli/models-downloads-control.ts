import {
  cancelDownloadJob,
  downloadJobId,
  pauseDownloadJob,
  readDownloadJob,
  resumeDownloadJob,
  type DownloadControlResult,
  type DownloadJob,
} from "../local-llm/index.js";

/**
 * `models downloads pause|resume|cancel <job-or-model-id>`.
 *
 * Pause stops the worker and keeps the partial file; resume launches it
 * again from where the partial ends; cancel stops it and deletes the
 * partial. See `local-llm/downloads/download-job-control.ts`.
 */

export type DownloadControlVerb = "pause" | "resume" | "cancel";

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function findDownloadJob(
  dataDir: string,
  ref: string,
): DownloadJob | null {
  return (
    readDownloadJob(dataDir, ref) ??
    readDownloadJob(dataDir, downloadJobId("chat", ref)) ??
    readDownloadJob(dataDir, downloadJobId("embedding", ref))
  );
}

/** Exit code and message for a stop the worker did not obey. */
function reportUnstopped(job: DownloadJob, result: DownloadControlResult): number | null {
  if (result.outcome === "foreign") {
    process.stderr.write(
      `download worker pid ${job.pid} belongs to another user; cannot stop it\n`,
    );
    return 1;
  }
  if (result.outcome === "still-running") {
    process.stderr.write(
      `sent stop to pid ${job.pid}, but it is still running\n`,
    );
    return 1;
  }
  return null;
}

export async function runDownloadControl(
  dataDir: string,
  verb: DownloadControlVerb,
  ref: string | undefined,
): Promise<number> {
  if (!ref) {
    process.stderr.write(`usage: models downloads ${verb} <job-or-model-id>\n`);
    return 2;
  }
  const job = findDownloadJob(dataDir, ref);
  if (!job) {
    process.stderr.write(`no download job matches ${JSON.stringify(ref)}\n`);
    return 1;
  }

  if (verb === "resume") {
    if (job.status === "running") {
      process.stdout.write(`${job.id} is already running\n`);
      return 0;
    }
    const result = resumeDownloadJob(dataDir, job);
    if (result.outcome === "not-resumable") {
      process.stdout.write(`${job.id} already finished\n`);
      return 0;
    }
    if (result.outcome === "already-running") {
      process.stdout.write(`${job.id} is already running\n`);
      return 0;
    }
    process.stdout.write(
      `${job.id} resumed in the background (pid ${result.job.pid})` +
        (result.job.transferredBytes > 0
          ? ` from ${formatBytes(result.job.transferredBytes)}`
          : "") +
        ` — watch it with 'atomic-agent models downloads'\n`,
    );
    return 0;
  }

  if (verb === "pause") {
    const result = await pauseDownloadJob(dataDir, job);
    const unstopped = reportUnstopped(job, result);
    if (unstopped !== null) return unstopped;
    if (result.outcome !== "paused") {
      process.stdout.write(`${job.id} is not running (${result.job.status})\n`);
      return 0;
    }
    process.stdout.write(
      `${job.id} paused at ${result.job.percent}%; ${formatBytes(
        result.job.transferredBytes,
      )} kept on disk — 'models downloads resume ${job.modelId}' continues it\n`,
    );
    return 0;
  }

  const result = await cancelDownloadJob(dataDir, job);
  const unstopped = reportUnstopped(job, result);
  if (unstopped !== null) return unstopped;
  if (result.outcome !== "cancelled") {
    process.stdout.write(`${job.id} already finished (${result.job.status})\n`);
    return 0;
  }
  process.stdout.write(
    `${job.id} cancelled; the partial download was deleted ` +
      `(use 'models downloads pause ${job.modelId}' to stop and keep it)\n`,
  );
  return 0;
}
