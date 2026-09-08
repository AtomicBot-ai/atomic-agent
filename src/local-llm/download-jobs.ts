import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { classifyPidLiveness } from "./daemon-lifecycle.js";

/**
 * Background model downloads: the on-disk contract between the worker
 * that fetches the bytes and whoever is watching it (`models pull`,
 * `models downloads`, the TUI).
 *
 * A download runs in its own detached process — the same way the
 * llama-server daemon does — so closing the terminal or quitting the
 * TUI does not kill it. Each job is one file,
 * `<dataDir>/downloads/<jobId>.json`, rewritten atomically by the
 * worker as progress arrives, plus `<jobId>.log` with the worker's
 * stdout/stderr. Watchers only ever read the JSON; nothing here holds
 * a lock or an open socket, so a watcher can come and go freely.
 *
 * Liveness is decided from the recorded pid, as for the daemon's pid
 * file: a `running` job whose pid is dead was interrupted (a crash, a
 * reboot, a `kill -9`) and is reported as such. Its partial file is
 * still on disk (see `download-file.ts`), so starting the same job
 * again resumes rather than restarts.
 */

/**
 * Still 1: `waiting` and `resumable` (0.5.7) are additive, and a reader
 * that does not know them — an older binary sharing the state dir, or
 * a downgrade — must keep seeing the record, or it would spawn a second
 * worker onto a partial that is being written.
 */
export const DOWNLOAD_JOB_VERSION = 1;

/**
 * A `running` record older than this has a worker that stopped writing:
 * the worker heartbeats every 30s even while it waits for the network,
 * so ten missed beats is not a slow disk. Readers treat such a job as
 * interrupted after a grace period of their own — a laptop waking from
 * sleep shows a stale record for a moment before the worker's next beat.
 */
export const STALE_RUNNING_MS = 5 * 60 * 1_000;

export type DownloadJobKind = "chat" | "embedding";

/** Which files of a chat model the job fetches; embedding jobs ignore it. */
export type DownloadJobMode = "with-mmproj" | "gguf-only" | "mmproj-only";

export type DownloadJobStatus =
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  /** Recorded `running`, but the worker pid is gone. Resumable. */
  | "interrupted";

/**
 * The worker is between attempts, waiting out a transport failure. The
 * bytes on disk are not moving and that is expected; a UI shows this
 * instead of a frozen counter.
 */
export interface DownloadJobWaiting {
  /** The last attempt's error, e.g. `fetch failed`. */
  reason: string;
  /** Consecutive attempts without progress. */
  attempt: number;
  nextRetryAt: string;
  /** When the no-progress streak began. */
  since: string;
}

export interface DownloadJob {
  version: typeof DOWNLOAD_JOB_VERSION;
  id: string;
  kind: DownloadJobKind;
  modelId: string;
  mode: DownloadJobMode;
  pid: number;
  status: DownloadJobStatus;
  /** Which file the numbers below describe. */
  phase: "gguf" | "mmproj";
  label: string;
  percent: number;
  transferredBytes: number;
  totalBytes: number;
  error: string | null;
  /** Set while the worker waits between attempts; `null` while bytes flow. */
  waiting: DownloadJobWaiting | null;
  /**
   * For a `failed` job: the outage, not the file, was the problem, so
   * starting the same job again resumes it. A relaunch does that by
   * itself. `false` for a 404, a full disk, a changed file.
   */
  resumable: boolean;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export function resolveDownloadsDir(dataDir: string): string {
  return join(dataDir, "downloads");
}

/**
 * One job per (kind, model). Model ids are already filesystem-safe:
 * curated ones are hand-written slugs and custom ones go through
 * `buildCustomModelId`'s character filter.
 */
export function downloadJobId(kind: DownloadJobKind, modelId: string): string {
  return `${kind}-${modelId}`;
}

export function resolveDownloadJobPath(dataDir: string, jobId: string): string {
  return join(resolveDownloadsDir(dataDir), `${jobId}.json`);
}

export function resolveDownloadLogPath(dataDir: string, jobId: string): string {
  return join(resolveDownloadsDir(dataDir), `${jobId}.log`);
}

/**
 * Atomic replace: a watcher polling every few hundred milliseconds must
 * never read a half-written file. The temp name carries the writer's pid
 * so two writers (a worker and the spawner seeding the first record)
 * cannot collide on it.
 */
export function writeDownloadJob(dataDir: string, job: DownloadJob): void {
  const dir = resolveDownloadsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const path = resolveDownloadJobPath(dataDir, job.id);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

function parseDownloadJob(raw: string): DownloadJob | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const j = parsed as Record<string, unknown>;
  if (j.version !== DOWNLOAD_JOB_VERSION) return null;
  if (typeof j.id !== "string" || typeof j.modelId !== "string") return null;
  if (j.kind !== "chat" && j.kind !== "embedding") return null;
  if (typeof j.pid !== "number" || typeof j.status !== "string") return null;
  return fillAdditiveFields(j);
}

/**
 * 0.5.6 wrote neither `waiting` nor `resumable`, and its worker recorded
 * an exhausted network budget as a plain `failed`, indistinguishable
 * from a 404 — that is the record a 0.5.6 user has on disk after going
 * offline. Read such a failure as resumable unless the error names an
 * HTTP status a retry cannot change, so the relaunch picks it back up.
 */
function fillAdditiveFields(j: Record<string, unknown>): DownloadJob {
  const error = typeof j.error === "string" ? j.error : null;
  const resumable =
    typeof j.resumable === "boolean"
      ? j.resumable
      : j.status === "failed" && !/HTTP 4(?!08|29)\d\d/.test(error ?? "");
  return {
    ...(j as unknown as DownloadJob),
    waiting: j.waiting && typeof j.waiting === "object" ? (j.waiting as DownloadJob["waiting"]) : null,
    resumable,
  };
}

/**
 * Reconcile the recorded status with reality. Pure so the transition
 * is testable without a real dead process: `isAlive` answers for the
 * recorded pid.
 */
export function reconcileDownloadJob(
  job: DownloadJob,
  isAlive: (pid: number) => boolean,
): DownloadJob {
  if (job.status !== "running") return job;
  if (isAlive(job.pid)) return job;
  return {
    ...job,
    status: "interrupted",
    error: job.error ?? "worker process is gone",
    finishedAt: job.finishedAt ?? job.updatedAt,
  };
}

function pidIsAlive(pid: number): boolean {
  // `foreign` (EPERM) is still alive — a worker started under sudo, say.
  return classifyPidLiveness(pid) !== "dead";
}

/**
 * Read one job, with a dead worker reported as `interrupted`. The
 * reconciled record is written back so the next reader (and the log of
 * what happened) agree, and so the interruption timestamp is not lost
 * to a later rewrite.
 */
export function readDownloadJob(dataDir: string, jobId: string): DownloadJob | null {
  let raw: string;
  try {
    raw = readFileSync(resolveDownloadJobPath(dataDir, jobId), "utf-8");
  } catch {
    return null;
  }
  const job = parseDownloadJob(raw);
  if (!job) return null;
  const reconciled = reconcileDownloadJob(job, pidIsAlive);
  if (reconciled !== job) {
    try {
      writeDownloadJob(dataDir, reconciled);
    } catch {
      /* the in-memory view is still right */
    }
  }
  return reconciled;
}

/** Every job on disk, newest start first, reconciled like `readDownloadJob`. */
export function listDownloadJobs(dataDir: string): DownloadJob[] {
  let entries: string[];
  try {
    entries = readdirSync(resolveDownloadsDir(dataDir));
  } catch {
    return [];
  }
  const jobs: DownloadJob[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const job = readDownloadJob(dataDir, entry.slice(0, -".json".length));
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** Forget a job: its record and its log. The partial file is not touched. */
export function removeDownloadJob(dataDir: string, jobId: string): void {
  for (const path of [
    resolveDownloadJobPath(dataDir, jobId),
    resolveDownloadLogPath(dataDir, jobId),
  ]) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** A job the worker may still be driving — or one that died mid-way. */
export function isDownloadJobLive(job: DownloadJob | null): job is DownloadJob {
  return job !== null && job.status === "running";
}

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
