import { getConfig } from "../config/index.js";
import {
  downloadJobId,
  downloadJobSilenceMs,
  isDownloadJobStale,
  listDownloadJobs,
  readDownloadJob,
  readDownloadNotify,
  removeDownloadJob,
  resolveDownloadsDir,
  runDownloadWorker,
  stopDownloadWorker,
  type DownloadJob,
  type DownloadJobMode,
} from "../local-llm/index.js";
import { notifyDownloadOutcome } from "../notifications/index.js";
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
    const dataDir = getConfig().paths.localModelsDataDir;
    const outcome = await runDownloadWorker({
      dataDir,
      kind: kindArg,
      modelId,
      mode,
      signal: controller.signal,
      // The ping is read now, not at launch: the operator may have armed
      // it from the TUI while the bytes were flowing. A cancel is the
      // operator's own doing and gets no message.
      beforeFinish: (job) => reportDownloadOutcome(dataDir, job),
    });
    return outcome === "done" ? 0 : 1;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("SIGHUP", onHangup);
  }
}

/** Send the armed ping, and hand back what to record about it. */
async function reportDownloadOutcome(
  dataDir: string,
  job: DownloadJob,
): Promise<Partial<DownloadJob>> {
  const channel = readDownloadNotify(dataDir, job.id);
  if (!channel) return {};
  const at = new Date().toISOString();
  // `getConfig()` already merged `<stateDir>/.env` into the environment,
  // so the bot tokens are where the notifier looks for them.
  const result = await notifyDownloadOutcome({ channel, job, config: getConfig() });
  const reason = result.outcome === "sent" ? null : result.reason;
  process.stdout.write(`[${at}] notify ${channel} ${result.outcome}${reason ? `: ${reason}` : ""}\n`);
  return { notified: { channel, outcome: result.outcome, reason, at } };
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** `waiting for network (attempt 4, retry in 32s)` — or `null` while bytes flow. */
export function describeDownloadWait(
  job: Pick<DownloadJob, "waiting">,
  now: number = Date.now(),
): string | null {
  if (!job.waiting) return null;
  const inMs = Date.parse(job.waiting.nextRetryAt) - now;
  const when = Number.isFinite(inMs) && inMs > 0 ? `retry in ${Math.ceil(inMs / 1000)}s` : "retrying";
  return `waiting for network (attempt ${job.waiting.attempt}, ${when})`;
}

export function describeDownloadJob(
  job: DownloadJob,
  now: number = Date.now(),
  notify: string | null = null,
): string {
  const size =
    job.totalBytes > 0
      ? `${formatBytes(job.transferredBytes)} / ${formatBytes(job.totalBytes)}`
      : formatBytes(job.transferredBytes);
  let state: string;
  if (job.status === "running") {
    const wait = describeDownloadWait(job, now);
    state = `running (pid ${job.pid}) ${job.percent}%`;
    if (wait) state += ` · ${wait}`;
    else if (isDownloadJobStale(job, now)) {
      state += ` · not reporting for ${Math.round(downloadJobSilenceMs(job, now) / 60_000)} min`;
    }
  } else if (job.status === "failed") {
    state = `failed: ${job.error ?? "unknown error"}${job.resumable ? " (resumes on next launch)" : ""}`;
  } else {
    state = job.status;
  }
  const ping = job.notified
    ? `  → ${job.notified.channel} ${job.notified.outcome === "sent" ? "✓" : `✗ ${job.notified.reason ?? job.notified.outcome}`}`
    : notify
      ? `  → ${notify}`
      : "";
  return `${job.id.padEnd(40)} ${state.padEnd(28)} ${size}  ${job.label}${ping}`;
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
    process.stdout.write(
      `${describeDownloadJob(job, Date.now(), readDownloadNotify(dataDir, job.id))}\n`,
    );
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
  let lastWait: string | null = null;
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
      const wait = describeDownloadWait(job);
      if (wait !== lastWait) {
        if (wait) process.stderr.write(`${tty ? "\n" : ""}${wait} — the partial file is kept\n`);
        lastWait = wait;
      }
      if (job.status !== "running") {
        if (tty) process.stderr.write("\n");
        if (job.status === "done") return 0;
        process.stderr.write(
          job.status === "failed"
            ? `background download failed: ${job.error ?? "unknown error"}${job.resumable ? ` — partial kept; run 'models pull ${job.modelId}' or relaunch the app to resume` : ""}\n`
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
