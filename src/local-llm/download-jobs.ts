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

export const DOWNLOAD_JOB_VERSION = 1;

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
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /**
   * Set on a `done` chat job whose projector phase failed after the
   * GGUF had landed: the weights are usable text-only, any projector
   * partial is kept, and a later `mmproj-only` pull retries it.
   * Additive on version 1 — older readers ignore it.
   */
  mmprojError?: string | null;
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
  return j as unknown as DownloadJob;
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
