import { execFile } from "node:child_process";

import { getConfig } from "../../config/index.js";
import { readRunningPid } from "../../local-llm/index.js";

/**
 * Samples the current memory footprint of the *managed* llama-server so
 * the composer's status control can say `healthy · 4.4 GB`. Invoked by
 * `LlmHealthPoller` on its existing `/health` cadence — deliberately not
 * a timer of its own, because a second loop would just interleave with
 * the first for no fresher a number.
 *
 * `null` means "no RAM segment", never zero: external mode has no child
 * of ours to measure, a stopped daemon has no pid, and Windows has no
 * `ps` — all three read the same to the control, which simply drops the
 * segment rather than printing a made-up figure.
 */
export type DaemonRssSampler = () => Promise<number | null>;

/**
 * The moving parts, split out so tests can drive the sampling logic
 * without a config file, a pid file, or a real `ps` on the box.
 */
export interface DaemonRssDeps {
  /** `localModels.mode` — only `managed` daemons are ours to measure. */
  mode(): "external" | "managed";
  /** Live pid from the daemon's pid file, or `null` when it is down. */
  pid(): number | null;
  /** Raw `ps -o rss= -p <pid>` stdout (RSS in KiB). Rejects on failure. */
  psRss(pid: number): Promise<string>;
}

export async function sampleDaemonRss(
  deps: DaemonRssDeps,
): Promise<number | null> {
  // `ps` and its flag set are POSIX; on Windows the segment is simply
  // absent rather than guessed at via wmic/PowerShell round-trips.
  if (process.platform === "win32") return null;
  if (deps.mode() !== "managed") return null;
  const pid = deps.pid();
  if (pid === null) return null;
  try {
    return parsePsRssKb(await deps.psRss(pid));
  } catch {
    // A pid that died between the read and the `ps` call — the next
    // sample on the poll cadence will report the daemon gone.
    return null;
  }
}

/** `ps` reports RSS in KiB; the state slice stores bytes. */
export function parsePsRssKb(stdout: string): number | null {
  const kb = Number(stdout.trim());
  if (!Number.isFinite(kb) || kb <= 0) return null;
  return kb * 1024;
}

function runPsRss(pid: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-o", "rss=", "-p", String(pid)],
      { timeout: 2000 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/** The production sampler: real config, real pid file, real `ps`. */
export function sampleManagedDaemonRss(): Promise<number | null> {
  return sampleDaemonRss({
    mode: () => getConfig().localModels.mode,
    pid: () => readRunningPid(getConfig().paths.localModelsDataDir),
    psRss: runPsRss,
  });
}
