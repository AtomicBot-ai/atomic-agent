import { execSync, spawn as nodeSpawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";

import { getConfig } from "../config/index.js";
import {
  classifyPidLiveness,
  downloadJobId,
  initialDownloadJob,
  isDownloadJobLive,
  listDownloadJobs,
  readDownloadJob,
  removeDownloadJob,
  resolveDownloadLogPath,
  resolveDownloadsDir,
  runDownloadWorker,
  writeDownloadJob,
  type DownloadJob,
  type DownloadJobKind,
  type DownloadJobMode,
} from "../local-llm/index.js";
import { renderPullProgress } from "./pull-progress.js";
import { isSeaBuild, selfInvocation } from "./self-invocation.js";

/**
 * Background model downloads on the CLI.
 *
 * `models pull --background <id>` launches a detached copy of this
 * program running `models pull-worker`, wires its output to
 * `<dataDir>/downloads/<job>.log`, seeds the job record and returns at
 * once. The worker survives the terminal that started it: it is in its
 * own process group (`detached`), holds no tty, and its stdio is a
 * file, so a closed window's SIGHUP never reaches it — the exact
 * arrangement `startDaemon` uses for llama-server.
 *
 * `models downloads` lists jobs; `models downloads cancel <id>` stops
 * one, keeping its partial file for a later resume. A foreground
 * `models pull` of a model whose worker is alive follows that worker's
 * progress instead of racing it for the same bytes.
 */

export interface SpawnDownloadWorkerInput {
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
 * the test can pin the exact shape the dispatcher parses.
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
  const dataDir = getConfig().paths.localModelsDataDir;
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
    // Seed the record with the child's pid so `models downloads` lists
    // the job before the worker has written anything. The worker's own
    // first write replaces this with the same pid and live numbers.
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
 * The detached worker's entry point: `models pull-worker <kind> <id>
 * <mode>`. Hidden from help — nothing invokes it but the spawner. A
 * SIGTERM (what `downloads cancel` sends) becomes an abort, so the
 * record ends as `cancelled` rather than as a dead `running` pid.
 */
export async function runLocalModelsPullWorker(args: string[]): Promise<number> {
  const [kindArg, modelId, modeArg] = args;
  if ((kindArg !== "chat" && kindArg !== "embedding") || !modelId) {
    process.stderr.write("usage: models pull-worker <chat|embedding> <id> [mode]\n");
    return 2;
  }
  const mode: DownloadJobMode =
    modeArg === "with-mmproj" || modeArg === "mmproj-only" ? modeArg : "gguf-only";
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  // Detached and tty-less, the worker is outside the group a closing
  // terminal hangs up on — but Node's default for SIGHUP is to exit, so
  // any hangup that does reach it (an ssh session torn down around a
  // job started from it, a shell that forwards the signal) would kill
  // a download that has nothing to do with the terminal. Ignore it.
  const onHangup = (): void => undefined;
  process.on("SIGHUP", onHangup);
  try {
    const outcome = await runDownloadWorker({
      dataDir: getConfig().paths.localModelsDataDir,
      kind: kindArg,
      modelId,
      mode,
      signal: controller.signal,
    });
    return outcome === "done" ? 0 : 1;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("SIGHUP", onHangup);
  }
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function describeDownloadJob(job: DownloadJob): string {
  const size =
    job.totalBytes > 0
      ? `${formatBytes(job.transferredBytes)} / ${formatBytes(job.totalBytes)}`
      : formatBytes(job.transferredBytes);
  const state =
    job.status === "running"
      ? `running (pid ${job.pid}) ${job.percent}%`
      : job.status === "failed"
        ? `failed: ${job.error ?? "unknown error"}`
        : job.status;
  return `${job.id.padEnd(40)} ${state.padEnd(28)} ${size}  ${job.label}`;
}

/**
 * `models downloads [cancel <job-or-model-id>] [clear]`.
 */
export async function runLocalModelsDownloads(args: string[]): Promise<number> {
  const dataDir = getConfig().paths.localModelsDataDir;
  const sub = args[0];
  if (sub === "cancel") {
    return cancelDownload(dataDir, args[1]);
  }
  if (sub === "clear") {
    let n = 0;
    for (const job of listDownloadJobs(dataDir)) {
      if (job.status === "running") continue;
      removeDownloadJob(dataDir, job.id);
      n += 1;
    }
    process.stdout.write(`cleared ${n} finished download record(s)\n`);
    return 0;
  }
  if (sub && sub !== "list") {
    process.stderr.write("usage: models downloads [list|cancel <id>|clear]\n");
    return 2;
  }
  const jobs = listDownloadJobs(dataDir);
  if (jobs.length === 0) {
    process.stdout.write("no background downloads\n");
    return 0;
  }
  process.stdout.write(
    `${"JOB".padEnd(40)} ${"STATE".padEnd(28)} PROGRESS\n`,
  );
  for (const job of jobs) {
    process.stdout.write(`${describeDownloadJob(job)}\n`);
  }
  process.stdout.write(
    `\nlogs: ${resolveDownloadsDir(dataDir)}/<job>.log · resume an interrupted one with 'models pull [--background] <id>'\n`,
  );
  return 0;
}

function findJob(dataDir: string, ref: string): DownloadJob | null {
  return (
    readDownloadJob(dataDir, ref) ??
    readDownloadJob(dataDir, downloadJobId("chat", ref)) ??
    readDownloadJob(dataDir, downloadJobId("embedding", ref))
  );
}

async function cancelDownload(dataDir: string, ref: string | undefined): Promise<number> {
  if (!ref) {
    process.stderr.write("usage: models downloads cancel <job-or-model-id>\n");
    return 2;
  }
  const job = findJob(dataDir, ref);
  if (!job) {
    process.stderr.write(`no download job matches ${JSON.stringify(ref)}\n`);
    return 1;
  }
  if (job.status !== "running") {
    process.stdout.write(`${job.id} is not running (${job.status})\n`);
    return 0;
  }
  if (classifyPidLiveness(job.pid) === "foreign") {
    process.stderr.write(
      `download worker pid ${job.pid} belongs to another user; cannot stop it\n`,
    );
    return 1;
  }
  if (process.platform === "win32") {
    // No signal handlers on Windows: the worker is killed outright and
    // its record reconciles to `interrupted` on the next read, which is
    // equally resumable.
    try {
      execSync(`taskkill /PID ${job.pid} /T /F`, { timeout: 5000, stdio: "ignore" });
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const now = readDownloadJob(dataDir, job.id);
    if (!now || now.status !== "running") {
      process.stdout.write(
        `${job.id} stopped (${now?.status ?? "gone"}); ${formatBytes(
          now?.transferredBytes ?? job.transferredBytes,
        )} kept on disk — 'models pull ${job.modelId}' resumes it\n`,
      );
      return 0;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  process.stderr.write(`sent stop to pid ${job.pid}, but it is still running\n`);
  return 1;
}

/**
 * Sit on a live worker's record and draw its progress until it ends.
 * Ctrl+C here detaches the watcher only — the worker keeps going, and
 * says so. Resolves to the exit code the foreground pull would have
 * produced.
 */
export async function followDownloadJob(
  dataDir: string,
  jobId: string,
  opts?: { pollMs?: number; sigint?: boolean },
): Promise<number> {
  const pollMs = opts?.pollMs ?? 500;
  const tty = process.stderr.isTTY;
  let detached = false;
  const onSigint = (): void => {
    detached = true;
  };
  if (opts?.sigint !== false) process.once("SIGINT", onSigint);
  let lastPercent = -1;
  try {
    for (;;) {
      const job = readDownloadJob(dataDir, jobId);
      if (!job) {
        process.stderr.write("\ndownload record disappeared\n");
        return 1;
      }
      const line = renderPullProgress(
        job.label,
        job.percent,
        job.transferredBytes,
        job.totalBytes,
      );
      if (tty) process.stderr.write(`\r${line.padEnd(79)}`);
      else if (job.percent !== lastPercent && (job.percent % 5 === 0 || job.status !== "running")) {
        process.stderr.write(`${line}\n`);
      }
      lastPercent = job.percent;
      if (job.status !== "running") {
        if (tty) process.stderr.write("\n");
        if (job.status === "done") return 0;
        process.stderr.write(
          job.status === "failed"
            ? `background download failed: ${job.error ?? "unknown error"}\n`
            : `background download ${job.status}; partial kept — run 'models pull ${job.modelId}' to resume\n`,
        );
        return 1;
      }
      if (detached) {
        if (tty) process.stderr.write("\n");
        process.stderr.write(
          `detached — the download continues in the background (pid ${job.pid}); watch it with 'atomic-agent models downloads'\n`,
        );
        return 0;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}
