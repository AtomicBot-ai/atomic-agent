import { resolveModelFilePath, resolveMmprojFilePath } from "./backend-paths.js";
import { readPartialDownload } from "./download-file.js";
import {
  downloadJobId,
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
  /** Test seam. */
  now?: () => Date;
}

export type DownloadWorkerOutcome = "done" | "failed" | "cancelled";

const DEFAULT_WRITE_INTERVAL_MS = 500;

const isAbortError = (err: unknown): boolean =>
  err instanceof Error && err.name === "AbortError";

/**
 * Seed the record a spawner writes the instant the worker is launched,
 * so `models downloads` lists the job before the worker has opened its
 * first socket. The worker overwrites it with real numbers as soon as
 * they exist; partials already on disk count from the start, so a
 * resumed job never shows 0% even for a moment.
 */
export function initialDownloadJob(input: {
  dataDir: string;
  kind: DownloadJobKind;
  modelId: string;
  mode: DownloadJobMode;
  pid: number;
  now?: Date;
}): DownloadJob {
  const now = (input.now ?? new Date()).toISOString();
  const { label, phase, files } = describeJobFiles(input);
  let transferred = 0;
  let total = 0;
  for (const file of files) {
    const partial = readPartialDownload(file.dest);
    transferred += partial?.transferred ?? 0;
    total += partial?.total || file.estTotal;
  }
  return {
    version: 1,
    id: downloadJobId(input.kind, input.modelId),
    kind: input.kind,
    modelId: input.modelId,
    mode: input.mode,
    pid: input.pid,
    status: "running",
    phase,
    label,
    percent: total > 0 ? Math.round((transferred / total) * 100) : 0,
    transferredBytes: transferred,
    totalBytes: total,
    error: null,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
  };
}

const gb = (n: number | undefined): number => Math.round((n ?? 0) * 1024 * 1024 * 1024);

interface JobFile {
  dest: string;
  estTotal: number;
}

/**
 * What a job is about to fetch, as the record describes it from its
 * first write. A vision pull that still needs both files is one job over
 * two files fetched together: the label names both and the byte counts
 * are their sum, so the TUI's bar never resets between files.
 */
function describeJobFiles(input: {
  dataDir: string;
  kind: DownloadJobKind;
  modelId: string;
  mode: DownloadJobMode;
}): { label: string; phase: DownloadJob["phase"]; files: JobFile[] } {
  if (input.kind === "embedding") {
    const def = getEmbeddingModelDef(input.modelId as EmbeddingModelId);
    return {
      label: def.name,
      phase: "gguf",
      files: [
        {
          dest: resolveModelFilePath(input.dataDir, def.id, def.filename),
          estTotal: gb(def.fileSizeGb),
        },
      ],
    };
  }
  const def = getLocalModelDef(input.modelId as LocalModelId);
  const gguf: JobFile = {
    dest: resolveModelFilePath(input.dataDir, def.id, def.filename),
    estTotal: gb(def.fileSizeGb),
  };
  const mmproj: JobFile | null = def.mmprojFilename
    ? {
        dest: resolveMmprojFilePath(input.dataDir, def.id, def.mmprojFilename),
        estTotal: gb(def.mmprojFileSizeGb ?? 1),
      }
    : null;
  const needGguf = input.mode !== "mmproj-only" && !isModelDownloaded(input.dataDir, def);
  const needMmproj =
    mmproj !== null &&
    (input.mode === "with-mmproj" || input.mode === "mmproj-only") &&
    !isMmprojDownloaded(input.dataDir, def);
  if (needGguf && needMmproj && mmproj) {
    return { label: `${def.name} (gguf + mmproj)`, phase: "gguf", files: [gguf, mmproj] };
  }
  if (needMmproj && mmproj) {
    return { label: `${def.name} (mmproj)`, phase: "mmproj", files: [mmproj] };
  }
  return { label: `${def.name} (gguf)`, phase: "gguf", files: [gguf] };
}

/**
 * Run one job to completion. Never throws for a download failure — the
 * outcome is the return value and the record on disk; the worker maps it
 * to an exit code. Throws only for a bad job spec (an unknown model id),
 * which the spawner should have rejected already.
 */
export async function runDownloadWorker(
  input: DownloadWorkerInput,
): Promise<DownloadWorkerOutcome> {
  const log = input.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = input.now ?? (() => new Date());
  const writeIntervalMs = input.writeIntervalMs ?? DEFAULT_WRITE_INTERVAL_MS;
  const stamp = (): string => now().toISOString();

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
      onProgress: (percent: number, transferred: number, total: number) => {
        persist(
          {
            percent,
            transferredBytes: transferred,
            totalBytes: total > 0 ? total : estTotal,
          },
          first,
        );
        first = false;
      },
      onRetry: (info: { attempt: number; maxRetries: number; delayMs: number; error: Error }) => {
        log(
          `[${stamp()}] interrupted (${info.error.message}) — retry ${info.attempt}/${info.maxRetries} in ${Math.round(info.delayMs / 1000)}s`,
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
        def.supportsVision && (input.mode === "with-mmproj" || input.mode === "mmproj-only");
      const needGguf = wantGguf && !isModelDownloaded(input.dataDir, def);
      const needMmproj = wantMmproj && !isMmprojDownloaded(input.dataDir, def);
      if (needGguf && needMmproj) {
        await downloadGgufAndMmprojTogether(def, input, { persist, log, stamp });
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
            resolveMmprojFilePath(input.dataDir, def.id, def.mmprojFilename ?? ""),
            gb(def.mmprojFileSizeGb ?? 1),
          ),
        );
        log(`[${stamp()}] mmproj complete`);
      }
    }
    persist(
      { status: "done", percent: 100, error: null, finishedAt: stamp() },
      true,
    );
    log(`[${stamp()}] done`);
    return "done";
  } catch (err) {
    if (isAbortError(err) || input.signal?.aborted) {
      persist({ status: "cancelled", finishedAt: stamp() }, true);
      log(`[${stamp()}] cancelled — partial kept for resume`);
      return "cancelled";
    }
    const message = err instanceof Error ? err.message : String(err);
    persist({ status: "failed", error: message, finishedAt: stamp() }, true);
    log(`[${stamp()}] failed: ${message}`);
    return "failed";
  }
}

