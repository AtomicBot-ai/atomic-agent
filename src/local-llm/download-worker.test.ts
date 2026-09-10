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

import { resolveMmprojFilePath, resolveModelFilePath } from "./backend-paths.js";
import { resolvePartialMetaPath, resolvePartialPath } from "./download-file.js";
import { downloadJobId, readDownloadJob } from "./download-jobs.js";
import { initialDownloadJob, runDownloadWorker } from "./download-worker.js";
import { getEmbeddingModelDef, getLocalModelDef } from "./models-catalog.js";

const EMB = getEmbeddingModelDef("nomic-embed-text-v1.5");
const CHAT = getLocalModelDef("qwen-3.5-4b");
const VISION = getLocalModelDef("gemma-4-e4b");

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

  it("fetches a vision model's GGUF and mmproj together under one summed record", async () => {
    // Each body parks until the other request has arrived, so the test
    // only completes when the two downloads overlap in time.
    let arrived = 0;
    const releases: Array<() => void> = [];
    const bothArrived = new Promise<void>((resolve) => releases.push(resolve));
    globalThis.fetch = vi.fn(async (url: unknown) => {
      arrived += 1;
      if (arrived === 2) releases.forEach((r) => r());
      const isMmproj = String(url) === VISION.mmprojUrl;
      const payload = isMmproj ? "mm" : "weights!";
      const body = new ReadableStream({
        async pull(controller) {
          await bothArrived;
          controller.enqueue(Buffer.from(payload));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(payload.length) },
      });
    }) as typeof fetch;

    const outcome = await runDownloadWorker({
      dataDir,
      kind: "chat",
      modelId: VISION.id,
      mode: "with-mmproj",
      log: (l) => log.push(l),
      writeIntervalMs: 0,
    });

    expect(outcome).toBe("done");
    expect(
      readFileSync(resolveModelFilePath(dataDir, VISION.id, VISION.filename), "utf-8"),
    ).toBe("weights!");
    expect(
      readFileSync(
        resolveMmprojFilePath(dataDir, VISION.id, VISION.mmprojFilename ?? ""),
        "utf-8",
      ),
    ).toBe("mm");
    const job = readDownloadJob(dataDir, downloadJobId("chat", VISION.id));
    expect(job).toMatchObject({
      status: "done",
      label: `${VISION.name} (gguf + mmproj)`,
      percent: 100,
      transferredBytes: 10,
      totalBytes: 10,
    });
    expect(log.some((l) => /gguf complete/.test(l))).toBe(true);
    expect(log.some((l) => /mmproj complete/.test(l))).toBe(true);
  });

  it("a failing mmproj cancels the GGUF transfer and keeps its partial", async () => {
    let releaseGguf: (() => void) | null = null;
    const ggufDest = resolveModelFilePath(dataDir, VISION.id, VISION.filename);
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (String(url) === VISION.mmprojUrl) {
        // Fail only once the weights have bytes on disk, so the test
        // shows the cancel keeps them rather than racing the first chunk.
        await waitFor(() => {
          try {
            return readFileSync(resolvePartialPath(ggufDest), "utf-8") === "ab";
          } catch {
            return false;
          }
        });
        return new Response(null, { status: 404, statusText: "Not Found" });
      }
      const body = new ReadableStream({
        async pull(controller) {
          if (releaseGguf === null) {
            controller.enqueue(Buffer.from("ab"));
            await new Promise<void>((resolve) => {
              releaseGguf = resolve;
            });
            controller.enqueue(Buffer.from("cd"));
            return;
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-length": "4" } });
    }) as typeof fetch;

    const outcome = await runDownloadWorker({
      dataDir,
      kind: "chat",
      modelId: VISION.id,
      mode: "with-mmproj",
      log: (l) => log.push(l),
      writeIntervalMs: 0,
    });
    releaseGguf?.();

    expect(outcome).toBe("failed");
    const job = readDownloadJob(dataDir, downloadJobId("chat", VISION.id));
    expect(job?.status).toBe("failed");
    expect(job?.error).toMatch(/HTTP 404/);
    const dest = resolveModelFilePath(dataDir, VISION.id, VISION.filename);
    expect(existsSync(dest)).toBe(false);
    expect(readFileSync(resolvePartialPath(dest), "utf-8")).toBe("ab");
  });

  it("initialDownloadJob sums both files of a vision pull that needs both", () => {
    const job = initialDownloadJob({
      dataDir,
      kind: "chat",
      modelId: VISION.id,
      mode: "with-mmproj",
      pid: 1,
    });
    const gb = (n: number): number => Math.round(n * 1024 * 1024 * 1024);
    expect(job.label).toBe(`${VISION.name} (gguf + mmproj)`);
    expect(job.phase).toBe("gguf");
    expect(job.totalBytes).toBe(gb(VISION.fileSizeGb) + gb(VISION.mmprojFileSizeGb ?? 1));
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
