import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveModelFilePath } from "./backend-paths.js";
import { resolvePartialMetaPath, resolvePartialPath } from "./download-file.js";
import { downloadJobId, readDownloadJob } from "./download-jobs.js";
import { initialDownloadJob, runDownloadWorker } from "./download-worker.js";
import { getEmbeddingModelDef, getLocalModelDef } from "./models-catalog.js";

const EMB = getEmbeddingModelDef("nomic-embed-text-v1.5");
const CHAT = getLocalModelDef("qwen-3.5-4b");

function bodyOf(chunks: readonly string[]): ReadableStream {
  const queue = [...chunks];
  return new ReadableStream({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(Buffer.from(next));
    },
  });
}

describe("download-worker", () => {
  let dataDir: string;
  let prevFetch: typeof fetch;
  let log: string[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "atomic-dl-worker-"));
    prevFetch = globalThis.fetch;
    log = [];
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("fetches an embedding model, keeping the job record current, and ends done", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(bodyOf(["abc", "def"]), {
        status: 200,
        headers: { "content-length": "6" },
      }),
    ) as typeof fetch;

    const outcome = await runDownloadWorker({
      dataDir,
      kind: "embedding",
      modelId: EMB.id,
      mode: "gguf-only",
      log: (l) => log.push(l),
      writeIntervalMs: 0,
    });

    expect(outcome).toBe("done");
    expect(readFileSync(resolveModelFilePath(dataDir, EMB.id, EMB.filename), "utf-8")).toBe(
      "abcdef",
    );
    const job = readDownloadJob(dataDir, downloadJobId("embedding", EMB.id));
    expect(job).toMatchObject({
      kind: "embedding",
      modelId: EMB.id,
      status: "done",
      percent: 100,
      transferredBytes: 6,
      totalBytes: 6,
      pid: process.pid,
      error: null,
    });
    expect(job?.finishedAt).not.toBeNull();
    expect(log.some((l) => /\bstart\b/.test(l))).toBe(true);
    expect(log.at(-1)).toMatch(/done/);
  });

  it("records a failure with its message and keeps the partial", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 404, statusText: "Not Found" }),
    ) as typeof fetch;

    const outcome = await runDownloadWorker({
      dataDir,
      kind: "chat",
      modelId: CHAT.id,
      mode: "gguf-only",
      log: (l) => log.push(l),
      writeIntervalMs: 0,
    });

    expect(outcome).toBe("failed");
    const job = readDownloadJob(dataDir, downloadJobId("chat", CHAT.id));
    expect(job?.status).toBe("failed");
    expect(job?.error).toMatch(/HTTP 404/);
    expect(log.at(-1)).toMatch(/failed: .*404/);
  });

  it("ends cancelled when the signal fires, with the partial kept for resume", async () => {
    let release: (() => void) | null = null;
    const body = new ReadableStream({
      async pull(controller) {
        if (release === null) {
          controller.enqueue(Buffer.from("ab"));
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          controller.enqueue(Buffer.from("cd"));
          return;
        }
        controller.close();
      },
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(body, { status: 200, headers: { "content-length": "4" } }),
    ) as typeof fetch;

    const controller = new AbortController();
    const pending = runDownloadWorker({
      dataDir,
      kind: "chat",
      modelId: CHAT.id,
      mode: "gguf-only",
      signal: controller.signal,
      log: (l) => log.push(l),
      writeIntervalMs: 0,
    });
    await waitFor(() => release !== null);
    controller.abort();
    release?.();

    expect(await pending).toBe("cancelled");
    const job = readDownloadJob(dataDir, downloadJobId("chat", CHAT.id));
    expect(job?.status).toBe("cancelled");
    const dest = resolveModelFilePath(dataDir, CHAT.id, CHAT.filename);
    expect(existsSync(dest)).toBe(false);
    expect(readFileSync(resolvePartialPath(dest), "utf-8")).toBe("ab");
  });

  it("initialDownloadJob reports the partial already on disk instead of 0%", () => {
    const dest = resolveModelFilePath(dataDir, CHAT.id, CHAT.filename);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(resolvePartialPath(dest), Buffer.alloc(250));
    writeFileSync(
      resolvePartialMetaPath(dest),
      JSON.stringify({ url: CHAT.huggingFaceUrl, total: 1000, etag: null, lastModified: null }),
    );
    const job = initialDownloadJob({
      dataDir,
      kind: "chat",
      modelId: CHAT.id,
      mode: "gguf-only",
      pid: 4242,
      now: new Date("2026-09-07T12:00:00.000Z"),
    });
    expect(job).toMatchObject({
      id: downloadJobId("chat", CHAT.id),
      pid: 4242,
      status: "running",
      phase: "gguf",
      percent: 25,
      transferredBytes: 250,
      totalBytes: 1000,
      startedAt: "2026-09-07T12:00:00.000Z",
    });
  });

  it("initialDownloadJob sizes a fresh job from the catalog estimate", () => {
    const job = initialDownloadJob({
      dataDir,
      kind: "embedding",
      modelId: EMB.id,
      mode: "gguf-only",
      pid: 1,
    });
    expect(job.transferredBytes).toBe(0);
    expect(job.totalBytes).toBe(Math.round(EMB.fileSizeGb * 1024 * 1024 * 1024));
    expect(job.label).toBe(EMB.name);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}
