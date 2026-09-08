import { resolveMmprojFilePath, resolveModelFilePath } from "./backend-paths.js";
import { readPartialDownload } from "./download-file.js";
import type { DownloadJob } from "./download-jobs.js";
import type { DownloadWorkerInput } from "./download-worker.js";
import { downloadMmproj, downloadModel } from "./model-installer.js";
import type { LocalModelDef } from "./models-catalog.js";

const gb = (n: number | undefined): number => Math.round((n ?? 0) * 1024 * 1024 * 1024);

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * A vision pull that needs both files fetches them side by side rather
 * than one after the other: the projector is a few hundred MB next to a
 * multi-GB GGUF, and waiting for the weights to finish before starting
 * it added its whole transfer time to the pull. The record carries the
 * sum of both files; `phase` stays `gguf` until the weights land, then
 * reads `mmproj` for whatever the projector still owes. A failure in
 * either file cancels the other — partials are kept, and the retry
 * resumes both from where they stopped.
 */
export async function downloadGgufAndMmprojTogether(
  def: LocalModelDef,
  input: DownloadWorkerInput,
  io: {
    persist: (patch: Partial<DownloadJob>, force?: boolean) => void;
    log: (line: string) => void;
    stamp: () => string;
  },
): Promise<void> {
  const ggufDest = resolveModelFilePath(input.dataDir, def.id, def.filename);
  const mmprojDest = resolveMmprojFilePath(input.dataDir, def.id, def.mmprojFilename ?? "");
  const parts = {
    gguf: openingNumbers(ggufDest, gb(def.fileSizeGb)),
    mmproj: openingNumbers(mmprojDest, gb(def.mmprojFileSizeGb ?? 1)),
  };
  let ggufDone = false;
  const report = (force: boolean): void => {
    const transferred = parts.gguf.transferred + parts.mmproj.transferred;
    const total = parts.gguf.total + parts.mmproj.total;
    io.persist(
      {
        label: `${def.name} (gguf + mmproj)`,
        phase: ggufDone ? "mmproj" : "gguf",
        percent: total > 0 ? Math.round((transferred / total) * 100) : 0,
        transferredBytes: transferred,
        totalBytes: total,
      },
      force,
    );
  };
  report(true);

  // One controller for the pair: the caller's cancel and either file's
  // failure both stop the other file.
  const pair = new AbortController();
  const onCallerAbort = (): void => pair.abort();
  if (input.signal?.aborted) pair.abort();
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const fileOpts = (key: keyof typeof parts) => {
    let first = true;
    return {
      signal: pair.signal,
      onProgress: (_percent: number, transferred: number, total: number) => {
        parts[key] = { transferred, total: total > 0 ? total : parts[key].total };
        report(first);
        first = false;
      },
      onRetry: (info: { attempt: number; maxRetries: number; delayMs: number; error: Error }) => {
        io.log(
          `[${io.stamp()}] ${key} interrupted (${info.error.message}) — retry ${info.attempt}/${info.maxRetries} in ${Math.round(info.delayMs / 1000)}s`,
        );
      },
    };
  };
  const guard = (work: Promise<void>): Promise<void> =>
    work.catch((err: unknown) => {
      pair.abort();
      throw err;
    });
  try {
    const results = await Promise.allSettled([
      guard(
        downloadModel(input.dataDir, def, fileOpts("gguf")).then(() => {
          ggufDone = true;
          io.log(`[${io.stamp()}] gguf complete`);
          report(true);
        }),
      ),
      guard(
        downloadMmproj(input.dataDir, def, fileOpts("mmproj")).then(() => {
          io.log(`[${io.stamp()}] mmproj complete`);
          report(true);
        }),
      ),
    ]);
    const failures = results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
    if (failures.length > 0) {
      // The real cause comes first; the other file's AbortError is the
      // echo of our own cancel.
      throw failures.find((f) => !isAbortError(f)) ?? failures[0];
    }
  } finally {
    input.signal?.removeEventListener("abort", onCallerAbort);
  }
}

function openingNumbers(dest: string, estTotal: number): { transferred: number; total: number } {
  const partial = readPartialDownload(dest);
  return { transferred: partial?.transferred ?? 0, total: partial?.total || estTotal };
}
