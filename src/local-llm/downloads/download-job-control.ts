import {
  resolveModelFilePath,
  resolveMmprojFilePath,
} from "../backend-paths.js";
import {
  getEmbeddingModelDef,
  getLocalModelDef,
  type EmbeddingModelId,
  type LocalModelId,
} from "../catalog/models-catalog.js";
import {
  readDownloadJob,
  writeDownloadJob,
  type DownloadJob,
} from "./download-jobs.js";
import { discardPartialDownload } from "./download-partial.js";
import {
  requestDownloadPause,
  takeDownloadPauseRequest,
} from "./download-pause-request.js";
import {
  spawnDownloadWorker,
  stopDownloadWorker,
  type SpawnDownloadWorkerResult,
  type StopDownloadWorkerResult,
} from "./download-spawn.js";

/**
 * Pause, resume and cancel for a background download — what the operator
 * asks for, on top of the worker's own stop (`stopDownloadWorker`).
 *
 * The two ways to stop differ only in what happens to the bytes:
 *
 * - **Pause** stops the worker and keeps the partial file. The record
 *   reads `paused`, which nothing resumes by itself — not the TUI's
 *   launch-time adoption, not a staleness check — so the download waits
 *   for the operator, across restarts, for as long as they like.
 * - **Resume** is an ordinary relaunch: the worker reopens the partial
 *   and asks for the rest with a `Range` header (`download-resume.ts`).
 * - **Cancel** stops the worker and deletes the partial file, so the
 *   disk space comes back and the next pull starts from zero.
 */

export interface DownloadControlOptions {
  /** Test seam: how the running worker is stopped. */
  stop?: (dataDir: string, job: DownloadJob) => Promise<StopDownloadWorkerResult>;
  /** Test seam. */
  now?: () => Date;
}

export type DownloadControlResult =
  | { outcome: "paused" | "cancelled"; job: DownloadJob }
  /** Nothing to do: the job already finished, or is not in a state this applies to. */
  | { outcome: "not-running"; job: DownloadJob }
  /** The worker could not be stopped; the record and the partial are left as they were. */
  | { outcome: "foreign" | "still-running"; job: DownloadJob };

/**
 * Stop a running worker and hand back the record it left. `null` when
 * the job is over (landed, or its record is gone) and there is nothing
 * left to pause or cancel.
 */
async function stopIfRunning(
  dataDir: string,
  job: DownloadJob,
  opts: DownloadControlOptions,
): Promise<DownloadControlResult | DownloadJob | null> {
  if (job.status !== "running") return job;
  const stopped = await (opts.stop ?? stopDownloadWorker)(dataDir, job);
  if (stopped.outcome === "foreign" || stopped.outcome === "still-running") {
    return { outcome: stopped.outcome, job: stopped.job };
  }
  return readDownloadJob(dataDir, job.id);
}

/**
 * Pause a `running` job (or mark an `interrupted` one, so the next
 * launch does not resume it on its own). The partial file is kept.
 */
export async function pauseDownloadJob(
  dataDir: string,
  job: DownloadJob,
  opts: DownloadControlOptions = {},
): Promise<DownloadControlResult> {
  if (job.status !== "running" && job.status !== "interrupted") {
    return { outcome: "not-running", job };
  }
  // Asked for before the stop, so the worker itself records `paused`
  // and no watcher reads the job as cancelled in between. On Windows
  // (no signal handler) the record below does it instead.
  if (job.status === "running") requestDownloadPause(dataDir, job.id);
  const latest = await stopIfRunning(dataDir, job, opts);
  // Whatever happened, a request left behind must not turn a later
  // cancel into a pause.
  takeDownloadPauseRequest(dataDir, job.id);
  if (latest === null) return { outcome: "not-running", job };
  if ("outcome" in latest) return latest;
  // The worker may have landed the file, or failed for good, in the
  // moment before the stop reached it: that ending stands.
  if (
    latest.status !== "paused" &&
    latest.status !== "cancelled" &&
    latest.status !== "interrupted"
  ) {
    return { outcome: "not-running", job: latest };
  }
  const at = (opts.now?.() ?? new Date()).toISOString();
  const paused: DownloadJob = {
    ...latest,
    status: "paused",
    error: null,
    waiting: null,
    updatedAt: at,
    finishedAt: at,
  };
  writeDownloadJob(dataDir, paused);
  return { outcome: "paused", job: paused };
}

/**
 * Cancel a job: stop its worker if it runs, delete its partial files,
 * and record `cancelled`. Works on a paused, interrupted or failed job
 * too — that is how a paused download is thrown away. A finished job is
 * left alone: its files are the model, not a partial.
 */
export async function cancelDownloadJob(
  dataDir: string,
  job: DownloadJob,
  opts: DownloadControlOptions = {},
): Promise<DownloadControlResult> {
  if (job.status === "done") return { outcome: "not-running", job };
  const latest = await stopIfRunning(dataDir, job, opts);
  if (latest !== null && "outcome" in latest) return latest;
  if (latest?.status === "done") return { outcome: "not-running", job: latest };
  // Only once no worker writes to them any more.
  for (const dest of downloadJobPartialPaths(dataDir, job)) {
    discardPartialDownload(dest);
  }
  const at = (opts.now?.() ?? new Date()).toISOString();
  const cancelled: DownloadJob = {
    ...(latest ?? job),
    status: "cancelled",
    percent: 0,
    transferredBytes: 0,
    error: null,
    waiting: null,
    resumable: false,
    updatedAt: at,
    finishedAt: at,
  };
  writeDownloadJob(dataDir, cancelled);
  return { outcome: "cancelled", job: cancelled };
}

export type ResumeDownloadResult =
  | SpawnDownloadWorkerResult
  /** A finished job has nothing left to fetch. */
  | { outcome: "not-resumable"; job: DownloadJob };

/**
 * Resume a paused (or interrupted, failed, cancelled) job: launch the
 * worker again for the same files. It picks the partial up from where
 * it ends; after a cancel there is none and it starts over.
 */
export function resumeDownloadJob(
  dataDir: string,
  job: DownloadJob,
  opts: { spawn?: typeof spawnDownloadWorker } = {},
): ResumeDownloadResult {
  if (job.status === "done") return { outcome: "not-resumable", job };
  return (opts.spawn ?? spawnDownloadWorker)({
    dataDir,
    kind: job.kind,
    modelId: job.modelId,
    mode: job.mode,
  });
}

/**
 * Where the job's files land — their partials sit next to them as
 * `<dest>.part` and `<dest>.part.json`. Only the files the job's mode
 * fetches; nothing for a model added from disk or an id the catalogue
 * no longer knows.
 */
export function downloadJobPartialPaths(
  dataDir: string,
  job: Pick<DownloadJob, "kind" | "modelId" | "mode">,
): string[] {
  try {
    if (job.kind === "embedding") {
      const def = getEmbeddingModelDef(job.modelId as EmbeddingModelId);
      return [resolveModelFilePath(dataDir, def.id, def.filename)];
    }
    const def = getLocalModelDef(job.modelId as LocalModelId);
    if (def.localPath) return [];
    const paths: string[] = [];
    if (job.mode !== "mmproj-only") {
      paths.push(resolveModelFilePath(dataDir, def.id, def.filename));
    }
    if (def.mmprojFilename && job.mode !== "gguf-only") {
      paths.push(resolveMmprojFilePath(dataDir, def.id, def.mmprojFilename));
    }
    return paths;
  } catch {
    return [];
  }
}
