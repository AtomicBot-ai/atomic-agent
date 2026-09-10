import {
  resolveModelFilePath,
  resolveMmprojFilePath,
} from "./backend-paths.js";
import { isResumableDownloadError } from "./download-errors.js";
import {
  readPartialDownload,
  type DownloadRetryInfo,
} from "./download-file.js";
import { initialDownloadJob } from "./download-job-seed.js";
import {
  writeDownloadJob,
  type DownloadJob,
  type DownloadJobKind,
  type DownloadJobMode,
} from "./download-jobs.js";
import { downloadGgufAndMmprojTogether } from "./download-worker-pair.js";
import {
  downloadEmbeddingModel,
  downloadMmproj,
  downloadModel,
  isMmprojDownloaded,
  isModelDownloaded,
} from "./model-installer.js";
import {
  getEmbeddingModelDef,
  getLocalModelDef,
  type EmbeddingModelId,
  type LocalModelId,
} from "./models-catalog.js";

export { initialDownloadJob } from "./download-job-seed.js";

/**
 * The body of a background download: fetch the files for one job while
 * keeping its record on disk current. Runs inside the detached worker
 * (`models pull-worker`) but takes everything as arguments, so a test can
 * drive it in-process against a mocked `fetch`.
 */
export interface DownloadWorkerInput {
  dataDir: string;
  kind: DownloadJobKind;
  modelId: string;
  mode: DownloadJobMode;
  /** Cancels the download; the job is then recorded as `cancelled`. */
  signal?: AbortSignal;
  /** Worker log line sink. Defaults to stdout. */
  log?: (line: string) => void;
  /** Progress writes are throttled to this. Default 500ms. */
  writeIntervalMs?: number;
  /**
   * The record is rewritten at least this often even when nothing
   * changes, so a reader can tell "alive, waiting for the network" from
   * "dead". Default 30s; `0` disables (tests).
   */
  heartbeatMs?: number;
  /** See `DownloadFileOptions.giveUpAfterMs`. Default 7 days. */
  giveUpAfterMs?: number;
  /** See `DownloadFileOptions.retryDelayMs`. Test seam. */
  retryDelayMs?: number;
  /**
   * Runs after the files landed (or the download failed for good) and
   * *before* the terminal record is written, with the record as it is
   * about to be written. Whatever it returns is merged into that write.
   * The place for the end-of-job ping: a watcher that sees `done` may
   * remove the record at once, so anything that must survive the job
   * has to be in the same write that ends it.
   */
  beforeFinish?: (job: DownloadJob) => Promise<Partial<DownloadJob> | void>;
  /**
   * The longest this worker may live, from its start. Default 30 days:
   * a download nobody has come back for in a month is not going to be
   * finished by a process that has been waiting all along. The partial
   * stays; the next launch resumes it.
   */
  maxLifetimeMs?: number;
  /** Test seam. */
  now?: () => Date;
}

export type DownloadWorkerOutcome = "done" | "failed" | "cancelled";

const DEFAULT_WRITE_INTERVAL_MS = 500;
const DEFAULT_HEARTBEAT_MS = 30_000;
/**
 * 7 days without a byte before the worker gives up on an outage. Nobody
 * is watching a detached worker, so it can afford to wait out a weekend
 * — or a week — away from the network; the partial on disk is what the
 * operator paid for and the relaunch resumes it either way.
 */
export const WORKER_GIVE_UP_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_WORKER_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

const isAbortError = (err: unknown): boolean =>
  err instanceof Error && err.name === "AbortError";

/** Catalogue sizes are in GB; every byte count here is exact. */
const gb = (n: number | undefined): number =>
  Math.round((n ?? 0) * 1024 * 1024 * 1024);

/**
 * Run one job to completion. Never throws for a download failure — the
 * outcome is the return value and the record on disk; the worker maps it
 * to an exit code. Throws only for a bad job spec (an unknown model id),
 * which the spawner should have rejected already.
 */
export async function runDownloadWorker(
  input: DownloadWorkerInput,
): Promise<DownloadWorkerOutcome> {
  const log =
    input.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = input.now ?? (() => new Date());
  const writeIntervalMs = input.writeIntervalMs ?? DEFAULT_WRITE_INTERVAL_MS;
  const heartbeatMs = input.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const stamp = (): string => now().toISOString();
  const deadlineAt =
    now().getTime() + (input.maxLifetimeMs ?? DEFAULT_WORKER_LIFETIME_MS);

  let job = initialDownloadJob({
    dataDir: input.dataDir,
    kind: input.kind,
    modelId: input.modelId,
    mode: input.mode,
    pid: process.pid,
    now: now(),
  });
  let lastWriteAt = 0;
  const persist = (patch: Partial<DownloadJob>, force = false): void => {
    job = { ...job, ...patch, updatedAt: stamp() };
    const t = Date.now();
    if (!force && t - lastWriteAt < writeIntervalMs) return;
    lastWriteAt = t;
    writeDownloadJob(input.dataDir, job);
  };
  persist({}, true);
  log(
    `[${stamp()}] start ${job.id} (${job.label}), ${job.transferredBytes} bytes already on disk`,
  );
  // Between attempts nothing moves the record; the beat is what keeps
  // it distinguishable from one a dead worker left behind.
  let heartbeatFailed = false;
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          if (Date.now() - lastWriteAt < heartbeatMs) return;
          try {
            persist({}, true);
          } catch (err) {
            // A downloads dir that stopped taking writes is not worth
            // dying over — the transfer is still fine — but it must not
            // be silent either, or the reader's "stale" verdict looks
            // like a mystery.
            if (!heartbeatFailed) {
              heartbeatFailed = true;
              log(
                `[${stamp()}] heartbeat write failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }, heartbeatMs)
      : null;
  heartbeat?.unref();
  // The hook's own failure must not turn a landed download into a
  // failed one: it is reported and the terminal write goes ahead.
  const finishHook = async (
    final: DownloadJob,
  ): Promise<Partial<DownloadJob>> => {
    if (!input.beforeFinish) return {};
    try {
      return (await input.beforeFinish(final)) ?? {};
    } catch (err) {
      log(
        `[${stamp()}] finish hook failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {};
    }
  };

  const phaseOpts = (
    label: string,
    phase: DownloadJob["phase"],
    dest: string,
    estTotal: number,
  ) => {
    // A phase opens on what its partial already holds, never on 0%: a
    // watcher that reads the record between this write and the first
    // (throttled) progress write must not see a resumed download reset.
    const partial = readPartialDownload(dest);
    const transferred = partial?.transferred ?? 0;
    const total = partial?.total || estTotal;
    persist(
      {
        label,
        phase,
        percent: total > 0 ? Math.round((transferred / total) * 100) : 0,
        transferredBytes: transferred,
        totalBytes: total,
      },
      true,
    );
    let first = true;
    return {
      signal: input.signal,
      giveUpAfterMs: input.giveUpAfterMs ?? WORKER_GIVE_UP_AFTER_MS,
      ...(input.retryDelayMs !== undefined
        ? { retryDelayMs: input.retryDelayMs }
        : {}),
      deadlineAt,
      onProgress: (percent: number, transferred: number, total: number) => {
        // The first byte after an outage closes the waiting state at
        // once — a forced write, so the UI does not show "offline" over
        // a moving counter for the throttle interval.
        const wasWaiting = job.waiting !== null;
        persist(
          {
            percent,
            transferredBytes: transferred,
            totalBytes: total > 0 ? total : estTotal,
            waiting: null,
          },
          first || wasWaiting,
        );
        first = false;
      },
      onRetry: (info: DownloadRetryInfo) => {
        const nextRetryAt = new Date(
          now().getTime() + info.delayMs,
        ).toISOString();
        persist(
          {
            waiting: {
              reason: info.error.message,
              attempt: info.attempt,
              nextRetryAt,
              since: new Date(info.since).toISOString(),
            },
          },
          true,
        );
        const budget =
          info.kind === "server"
            ? `retry ${info.attempt}/${info.maxRetries}`
            : `waiting for the network, attempt ${info.attempt}`;
        log(
          `[${stamp()}] interrupted (${info.error.message}) — ${budget}, next try in ${Math.round(info.delayMs / 1000)}s`,
        );
      },
    };
  };
  try {
    if (input.kind === "embedding") {
      const def = getEmbeddingModelDef(input.modelId as EmbeddingModelId);
      await downloadEmbeddingModel(
        input.dataDir,
        def,
        phaseOpts(
          def.name,
          "gguf",
          resolveModelFilePath(input.dataDir, def.id, def.filename),
          gb(def.fileSizeGb),
        ),
      );
    } else {
      const def = getLocalModelDef(input.modelId as LocalModelId);
      const wantGguf = input.mode !== "mmproj-only";
      const wantMmproj =
        def.supportsVision &&
        (input.mode === "with-mmproj" || input.mode === "mmproj-only");
      const needGguf = wantGguf && !isModelDownloaded(input.dataDir, def);
      const needMmproj = wantMmproj && !isMmprojDownloaded(input.dataDir, def);
      if (needGguf && needMmproj) {
        await downloadGgufAndMmprojTogether(def, input, {
          persist,
          log,
          stamp,
        });
      }
      if (needGguf && !needMmproj) {
        await downloadModel(
          input.dataDir,
          def,
          phaseOpts(
            `${def.name} (gguf)`,
            "gguf",
            resolveModelFilePath(input.dataDir, def.id, def.filename),
            gb(def.fileSizeGb),
          ),
        );
        log(`[${stamp()}] gguf complete`);
      }
      if (needMmproj && !needGguf) {
        await downloadMmproj(
          input.dataDir,
          def,
          phaseOpts(
            `${def.name} (mmproj)`,
            "mmproj",
            resolveMmprojFilePath(
              input.dataDir,
              def.id,
              def.mmprojFilename ?? "",
            ),
            gb(def.mmprojFileSizeGb ?? 1),
          ),
        );
        log(`[${stamp()}] mmproj complete`);
      }
    }
    const done: Partial<DownloadJob> = {
      status: "done",
      percent: 100,
      error: null,
      waiting: null,
      finishedAt: stamp(),
    };
    persist({ ...done, ...(await finishHook({ ...job, ...done })) }, true);
    log(`[${stamp()}] done`);
    return "done";
  } catch (err) {
    if (isAbortError(err) || input.signal?.aborted) {
      persist(
        { status: "cancelled", waiting: null, finishedAt: stamp() },
        true,
      );
      log(`[${stamp()}] cancelled — partial kept for resume`);
      return "cancelled";
    }
    const message = err instanceof Error ? err.message : String(err);
    const resumable = isResumableDownloadError(err);
    const failed: Partial<DownloadJob> = {
      status: "failed",
      error: message,
      waiting: null,
      resumable,
      finishedAt: stamp(),
    };
    persist({ ...failed, ...(await finishHook({ ...job, ...failed })) }, true);
    log(
      `[${stamp()}] failed: ${message}${resumable ? " — partial kept; the next launch resumes it" : ""}`,
    );
    return "failed";
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}
