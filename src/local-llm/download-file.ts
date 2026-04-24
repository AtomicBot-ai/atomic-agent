import * as fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type DownloadProgressFn = (
  percent: number,
  transferred: number,
  total: number,
) => void;

function createAbortError(): Error {
  const err = new Error("Download aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

/**
 * Download a file from `url` to `destPath` with optional progress tracking.
 * Writes to a `.tmp` file first, then renames atomically on success.
 */
export async function downloadFile(
  url: string,
  destPath: string,
  opts?: {
    onProgress?: DownloadProgressFn;
    userAgent?: string;
    signal?: AbortSignal;
  },
): Promise<void> {
  throwIfAborted(opts?.signal);
  const headers: Record<string, string> = {
    "User-Agent": opts?.userAgent ?? "atomic-agent/local-llm",
  };
  const isGitHub =
    url.includes("github.com") || url.includes("githubusercontent.com");
  if (isGitHub) {
    const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    headers,
    redirect: "follow",
    signal: opts?.signal,
  });
  throwIfAborted(opts?.signal);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  }

  const totalRaw = res.headers.get("content-length");
  const total = totalRaw ? parseInt(totalRaw, 10) : 0;
  let transferred = 0;
  let lastReportedPercent = -1;

  const reader = res.body.getReader();
  const trackingStream = new ReadableStream({
    async pull(controller) {
      throwIfAborted(opts?.signal);
      const { done, value } = await reader.read();
      throwIfAborted(opts?.signal);
      if (done) {
        controller.close();
        return;
      }
      transferred += value.byteLength;
      const percent = total > 0 ? Math.round((transferred / total) * 100) : 0;
      if (percent !== lastReportedPercent) {
        lastReportedPercent = percent;
        opts?.onProgress?.(percent, transferred, total);
      }
      controller.enqueue(value);
    },
  });

  const nodeReadable = Readable.fromWeb(
    trackingStream as import("node:stream/web").ReadableStream,
  );
  const tmpPath = `${destPath}.tmp`;
  try {
    const writeStream = fs.createWriteStream(tmpPath);
    await pipeline(nodeReadable, writeStream);
    throwIfAborted(opts?.signal);
    fs.renameSync(tmpPath, destPath);
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}
