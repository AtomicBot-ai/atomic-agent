import { getConfig } from "../config/index.js";
import {
  downloadJobId,
  listDownloadJobs,
  readDownloadJob,
  removeDownloadJob,
  resolveDownloadsDir,
  runDownloadWorker,
  stopDownloadWorker,
  type DownloadJob,
  type DownloadJobMode,
} from "../local-llm/index.js";
import { renderPullProgress } from "./pull-progress.js";

/**
 * Background model downloads on the CLI.
 *
 * `models pull --background <id>` launches the detached worker (see
 * `local-llm/download-spawn.ts`), which survives the terminal that
 * started it, and returns at once.
 *
 * `models downloads` lists jobs; `models downloads cancel <id>` stops
 * one, keeping its partial file for a later resume. A foreground
 * `models pull` of a model whose worker is alive follows that worker's
 * progress instead of racing it for the same bytes.
 */

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
        : job.status === "done" && job.mmprojError
          ? "done, text-only"
          : job.status;
  const label = job.mmprojError
    ? `${job.label} — projector: ${job.mmprojError}`
    : job.label;
  return `${job.id.padEnd(40)} ${state.padEnd(28)} ${size}  ${label}`;
}

/** The weights landed but the projector did not: usable text-only, retryable. */
export function describeProjectorSkipped(modelId: string, error: string): string {
  return (
    `note: projector download failed (${error}) — ${modelId} is usable text-only; ` +
    `'models pull --mmproj ${modelId}' retries the projector\n`
  );
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
  const result = await stopDownloadWorker(dataDir, job);
  switch (result.outcome) {
    case "foreign":
      process.stderr.write(
        `download worker pid ${job.pid} belongs to another user; cannot stop it\n`,
      );
      return 1;
    case "still-running":
      process.stderr.write(`sent stop to pid ${job.pid}, but it is still running\n`);
      return 1;
    default:
      process.stdout.write(
        `${job.id} stopped (${result.job.status}); ${formatBytes(
          result.job.transferredBytes,
        )} kept on disk — 'models pull ${job.modelId}' resumes it\n`,
      );
      return 0;
  }
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
        if (job.status === "done") {
          if (job.mmprojError) {
            process.stderr.write(describeProjectorSkipped(job.modelId, job.mmprojError));
          }
          return 0;
        }
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
