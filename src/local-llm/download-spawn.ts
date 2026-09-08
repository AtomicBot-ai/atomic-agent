import { execSync, spawn as nodeSpawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";

import { isSeaBuild, selfInvocation } from "../runtime/self-invocation.js";
import { classifyPidLiveness } from "./daemon-lifecycle.js";
import {
  downloadJobId,
  isDownloadJobLive,
  readDownloadJob,
  resolveDownloadLogPath,
  resolveDownloadsDir,
  writeDownloadJob,
  type DownloadJob,
  type DownloadJobKind,
  type DownloadJobMode,
} from "./download-jobs.js";
import { initialDownloadJob } from "./download-worker.js";

/**
 * Launching and stopping the detached download worker — shared by the
 * CLI (`models pull --background`) and the TUI, which runs every pull
 * through it so a quit never kills a download.
 *
 * The worker is a detached copy of this program running `models
 * pull-worker`, its stdio wired to `<dataDir>/downloads/<job>.log`. It
 * is in its own process group, holds no tty and ignores SIGHUP, so it
 * survives whatever started it — the same arrangement `startDaemon`
 * uses for llama-server.
 */

export interface SpawnDownloadWorkerInput {
  dataDir: string;
  kind: DownloadJobKind;
  modelId: string;
  mode: DownloadJobMode;
  /** Test seams. */
  spawn?: typeof nodeSpawn;
  execPath?: string;
  argv?: readonly string[];
  execArgv?: readonly string[];
  sea?: boolean;
  env?: NodeJS.ProcessEnv;
}

export type SpawnDownloadWorkerResult =
  | { outcome: "spawned"; job: DownloadJob; logPath: string }
  | { outcome: "already-running"; job: DownloadJob };

/**
 * The argv tail that reaches `modelsCommand` in the child. Exported so
 * a test can pin the exact shape the dispatcher parses.
 */
export function downloadWorkerArgs(input: {
  kind: DownloadJobKind;
  modelId: string;
  mode: DownloadJobMode;
}): string[] {
  return ["models", "pull-worker", input.kind, input.modelId, input.mode];
}

export function spawnDownloadWorker(
  input: SpawnDownloadWorkerInput,
): SpawnDownloadWorkerResult {
  const { dataDir } = input;
  const jobId = downloadJobId(input.kind, input.modelId);
  const existing = readDownloadJob(dataDir, jobId);
  if (isDownloadJobLive(existing)) {
    return { outcome: "already-running", job: existing };
  }

  const self = selfInvocation({
    execPath: input.execPath ?? process.execPath,
    argv: input.argv ?? process.argv,
    execArgv: input.execArgv ?? process.execArgv,
    isSea: input.sea ?? isSeaBuild(),
  });
  const args = [...self.args, ...downloadWorkerArgs(input)];

  mkdirSync(resolveDownloadsDir(dataDir), { recursive: true });
  const logPath = resolveDownloadLogPath(dataDir, jobId);
  const logFd = openSync(logPath, "a");
  try {
    const child = (input.spawn ?? nodeSpawn)(self.cmd, args, {
      stdio: ["ignore", logFd, logFd],
      detached: true,
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
      // The state dir and every other ATOMIC_AGENT_* knob travel by
      // environment; a worker reading a different `~/.atomic-agent`
      // would download into the wrong place.
      env: { ...(input.env ?? process.env) },
    });
    child.unref();
    if (child.pid == null) {
      throw new Error("spawn failed: no pid");
    }
    // Seed the record with the child's pid so watchers list the job
    // before the worker has written anything. The worker's own first
    // write replaces this with the same pid and live numbers.
    const job = initialDownloadJob({
      dataDir,
      kind: input.kind,
      modelId: input.modelId,
      mode: input.mode,
      pid: child.pid,
    });
    writeDownloadJob(dataDir, job);
    return { outcome: "spawned", job, logPath };
  } finally {
    closeSync(logFd);
  }
}

/**
 * Whether `pid` is one of our download workers, as far as the process
 * table can say. A `running` record whose pid answers `kill(pid, 0)`
 * after a reboot may belong to anything — a terminal, a browser — and a
 * SIGTERM sent on the strength of a stale record would land on it.
 * Best-effort: an unreadable process table reads as "not ours", which
 * errs toward leaving the pid alone.
 */
export function looksLikeDownloadWorker(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
      const image = out.split(",")[0]?.replace(/"/g, "").toLowerCase() ?? "";
      const self = process.execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
      return image.length > 0 && image === self;
    }
    const out = execSync(`ps -o args= -p ${pid}`, {
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return out.includes("pull-worker");
  } catch {
    return false;
  }
}

export type StopDownloadWorkerResult =
  | { outcome: "stopped"; job: DownloadJob }
  | { outcome: "not-running"; job: DownloadJob }
  | { outcome: "foreign"; job: DownloadJob }
  | { outcome: "still-running"; job: DownloadJob };

/**
 * Ask a running worker to stop and wait (bounded) for its record to say
 * so. SIGTERM on POSIX, which the worker turns into an abort and a
 * `cancelled` record; `taskkill /F` on Windows, where there are no
 * signal handlers — the record then reconciles to `interrupted` on the
 * next read, which is equally resumable. The partial file is never
 * touched.
 */
export async function stopDownloadWorker(
  dataDir: string,
  job: DownloadJob,
  opts?: {
    timeoutMs?: number;
    /** Test seams. */
    kill?: (pid: number) => void;
    pollMs?: number;
  },
): Promise<StopDownloadWorkerResult> {
  if (job.status !== "running") return { outcome: "not-running", job };
  if (classifyPidLiveness(job.pid) === "foreign") return { outcome: "foreign", job };
  const kill =
    opts?.kill ??
    ((pid: number): void => {
      if (process.platform === "win32") {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { timeout: 5000, stdio: "ignore" });
        } catch {
          /* ignore */
        }
      } else {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    });
  kill(job.pid);
  const deadline = Date.now() + (opts?.timeoutMs ?? 5000);
  const pollMs = opts?.pollMs ?? 200;
  for (;;) {
    const now = readDownloadJob(dataDir, job.id);
    if (!now) return { outcome: "stopped", job };
    if (now.status !== "running") return { outcome: "stopped", job: now };
    if (Date.now() >= deadline) return { outcome: "still-running", job: now };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
