import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import {
  resolveDownloadNotifyPath,
  resolveDownloadsDir,
} from "./download-jobs.js";

/** Where the worker reports when the job ends. */
export type DownloadNotifyChannel = "telegram" | "discord" | "email";

const NOTIFY_CHANNELS: readonly DownloadNotifyChannel[] = [
  "telegram",
  "discord",
  "email",
];

export function isDownloadNotifyChannel(
  raw: unknown,
): raw is DownloadNotifyChannel {
  return (
    typeof raw === "string" &&
    (NOTIFY_CHANNELS as readonly string[]).includes(raw)
  );
}

/**
 * The "tell me when it lands" request rides in its own file,
 * `<jobId>.notify`, not in the record: the worker rewrites the record
 * whole every few hundred milliseconds from memory, so a channel the
 * TUI armed after the spawn would be clobbered by the next progress
 * write. A sidecar the worker only ever reads — once, at the end —
 * lets a watcher arm or disarm it at any time, and it survives a
 * relaunch of the worker onto the same partial.
 */
/** Arm (`channel`) or disarm (`null`) the end-of-job report. */
export function writeDownloadNotify(
  dataDir: string,
  jobId: string,
  channel: DownloadNotifyChannel | null,
): void {
  const path = resolveDownloadNotifyPath(dataDir, jobId);
  if (channel === null) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* ignore */
    }
    return;
  }
  mkdirSync(resolveDownloadsDir(dataDir), { recursive: true });
  writeFileSync(path, `${channel}\n`, "utf-8");
}

export function readDownloadNotify(
  dataDir: string,
  jobId: string,
): DownloadNotifyChannel | null {
  try {
    const raw = readFileSync(
      resolveDownloadNotifyPath(dataDir, jobId),
      "utf-8",
    ).trim();
    return isDownloadNotifyChannel(raw) ? raw : null;
  } catch {
    return null;
  }
}
