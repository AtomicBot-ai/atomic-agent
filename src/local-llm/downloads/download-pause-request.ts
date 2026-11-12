import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import {
  resolveDownloadPausePath,
  resolveDownloadsDir,
} from "./download-jobs.js";

/**
 * The pause request rides in its own file, `<jobId>.pause`, written by
 * whoever pauses a running job just before it stops the worker. The
 * worker's abort path takes it and records `paused` rather than
 * `cancelled`, so no watcher reads the job as cancelled in between.
 */
export function requestDownloadPause(dataDir: string, jobId: string): void {
  mkdirSync(resolveDownloadsDir(dataDir), { recursive: true });
  writeFileSync(resolveDownloadPausePath(dataDir, jobId), "", "utf-8");
}

/** Whether a pause was asked for; the request is removed either way. */
export function takeDownloadPauseRequest(
  dataDir: string,
  jobId: string,
): boolean {
  const path = resolveDownloadPausePath(dataDir, jobId);
  let asked = false;
  try {
    readFileSync(path);
    asked = true;
  } catch {
    /* none */
  }
  try {
    rmSync(path, { force: true });
  } catch {
    /* ignore */
  }
  return asked;
}
