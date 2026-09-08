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

function dyingBodyOf(chunks: readonly string[], error: Error): ReadableStream {
  const queue = [...chunks];
  return new ReadableStream({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) {
        controller.error(error);
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
    // A 404 is the file's fault: relaunching would only ask again.
    expect(job?.resumable).toBe(false);
    expect(log.at(-1)).toMatch(/failed: .*404/);
  });

  it("records an outage as resumable so a relaunch picks the job back up", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
      });
    }) as typeof fetch;

    const outcome = await runDownloadWorker({
      dataDir,
      kind: "chat",
      modelId: CHAT.id,
      mode: "gguf-only",
      log: (l) => log.push(l),
      writeIntervalMs: 0,
      giveUpAfterMs: 0,
      heartbeatMs: 0,
    });

    expect(outcome).toBe("failed");
    const job = readDownloadJob(dataDir, downloadJobId("chat", CHAT.id));
    expect(job).toMatchObject({ status: "failed", resumable: true, waiting: null });
    expect(job?.error).toMatch(/gave up.*fetch failed/);
    expect(log.at(-1)).toMatch(/next launch resumes it/);
  });

  it("shows the wait between attempts in the record and clears it when bytes flow", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Response(dyingBodyOf(["ab"], new Error("read ECONNRESET")), {
          status: 200,
          headers: { "content-length": "4", etag: '"v1"' },
        });
      }
      if (calls === 2) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("ENETDOWN"), { code: "ENETDOWN" }),
        });
      }
      expect(new Headers(init?.headers).get("range")).toBe("bytes=2-");
      return new Response(bodyOf(["cd"]), {
        status: 206,
        headers: { "content-range": "bytes 2-3/4", etag: '"v1"' },
      });
    }) as typeof fetch;

    const pending = runDownloadWorker({
      dataDir,
      kind: "chat",
      modelId: CHAT.id,
      mode: "gguf-only",
      log: (l) => log.push(l),
      writeIntervalMs: 0,
      heartbeatMs: 0,
      retryDelayMs: 40,
    });
    const id = downloadJobId("chat", CHAT.id);
    await waitFor(() => readDownloadJob(dataDir, id)?.waiting?.attempt === 2);
    const waiting = readDownloadJob(dataDir, id);
    expect(waiting).toMatchObject({
      status: "running",
      transferredBytes: 2,
      waiting: { attempt: 2, reason: "fetch failed" },
    });
    expect(Date.parse(waiting!.waiting!.nextRetryAt)).toBeGreaterThan(
      Date.parse(waiting!.waiting!.since),
    );

    expect(await pending).toBe("done");
    expect(readDownloadJob(dataDir, id)).toMatchObject({ status: "done", waiting: null });
    expect(log.some((l) => /waiting for the network, attempt 1/.test(l))).toBe(true);
  });

  it("heartbeats the record while no bytes arrive", async () => {
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
      async () => new Response(body, { status: 200, headers: { "content-length": "4" } }),
    ) as typeof fetch;

    const pending = runDownloadWorker({
      dataDir,
      kind: "chat",
      modelId: CHAT.id,
      mode: "gguf-only",
      log: (l) => log.push(l),
      writeIntervalMs: 0,
      heartbeatMs: 15,
    });
    const id = downloadJobId("chat", CHAT.id);
    await waitFor(() => release !== null);
    // The first chunk's progress write lands on its own schedule; wait
    // for it so the beat is measured against a settled record.
    await waitFor(() => readDownloadJob(dataDir, id)?.transferredBytes === 2);
    const first = readDownloadJob(dataDir, id);
    await waitFor(() => readDownloadJob(dataDir, id)?.updatedAt !== first?.updatedAt);
    const later = readDownloadJob(dataDir, id);
    expect(later?.transferredBytes).toBe(first?.transferredBytes);
    expect(later?.status).toBe("running");
    release?.();
    expect(await pending).toBe("done");
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
