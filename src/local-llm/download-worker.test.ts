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

import {
  resolveMmprojFilePath,
  resolveModelFilePath,
} from "./backend-paths.js";
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

function fetchWithMissingProjector(): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return url.includes("mmproj")
      ? new Response(null, { status: 404, statusText: "Not Found" })
      : new Response(bodyOf(["gg", "uf"]), {
          status: 200,
          headers: { "content-length": "4" },
        });
  }) as typeof fetch;
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
    globalThis.fetch = vi.fn(
      async () =>
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
    expect(
      readFileSync(
        resolveModelFilePath(dataDir, EMB.id, EMB.filename),
        "utf-8",
      ),
    ).toBe("abcdef");
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

  it("runs beforeFinish before the terminal write and merges what it returns", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(bodyOf(["abc"]), {
          status: 200,
          headers: { "content-length": "3" },
        }),
    ) as typeof fetch;
    const id = downloadJobId("embedding", EMB.id);
    let statusSeenByHook: string | null = null;
    let statusOnDiskDuringHook: string | null = null;
    const outcome = await runDownloadWorker({
      dataDir,
      kind: "embedding",
      modelId: EMB.id,
      mode: "gguf-only",
      log: (l) => log.push(l),
      writeIntervalMs: 0,
      heartbeatMs: 0,
      beforeFinish: async (job) => {
        statusSeenByHook = job.status;
        statusOnDiskDuringHook = readDownloadJob(dataDir, id)?.status ?? null;
        return {
          notified: {
            channel: "telegram",
            outcome: "sent",
            reason: null,
            at: "2026-09-08T12:00:00.000Z",
          },
        };
      },
    });
    expect(outcome).toBe("done");
    expect(statusSeenByHook).toBe("done");
    // Nothing watching could have landed the job yet.
    expect(statusOnDiskDuringHook).toBe("running");
    expect(readDownloadJob(dataDir, id)?.notified).toMatchObject({
      channel: "telegram",
      outcome: "sent",
    });
  });

  it("a failing beforeFinish is logged and does not fail the download", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(bodyOf(["abc"]), {
          status: 200,
          headers: { "content-length": "3" },
        }),
    ) as typeof fetch;
    const outcome = await runDownloadWorker({
      dataDir,
      kind: "embedding",
      modelId: EMB.id,
      mode: "gguf-only",
      log: (l) => log.push(l),
      writeIntervalMs: 0,
      heartbeatMs: 0,
      beforeFinish: async () => {
        throw new Error("no network for the ping");
      },
    });
    expect(outcome).toBe("done");
    expect(
      readDownloadJob(dataDir, downloadJobId("embedding", EMB.id))?.status,
    ).toBe("done");
    expect(
      log.some((l) => /finish hook failed: no network for the ping/.test(l)),
    ).toBe(true);
  });

  it("records an outage as resumable so a relaunch picks the job back up", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), {
          code: "ENOTFOUND",
        }),
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
    expect(job).toMatchObject({
      status: "failed",
      resumable: true,
      waiting: null,
    });
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
    expect(readDownloadJob(dataDir, id)).toMatchObject({
      status: "done",
      waiting: null,
    });
    expect(log.some((l) => /waiting for the network, attempt 1/.test(l))).toBe(
      true,
    );
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
      async () =>
        new Response(body, { status: 200, headers: { "content-length": "4" } }),
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
    await waitFor(
      () => readDownloadJob(dataDir, id)?.updatedAt !== first?.updatedAt,
    );
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
      readFileSync(
        resolveModelFilePath(dataDir, VISION.id, VISION.filename),
        "utf-8",
      ),
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

  it("a failing mmproj lets the GGUF finish and lands the model text-only", async () => {
    // #364's rule wins over the pair's original one: a projector the
    // repo no longer serves costs vision, not a multi-GB download. The
    // weights leg is no longer cancelled by the projector's 404.
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
      return new Response(body, {
        status: 200,
        headers: { "content-length": "4" },
      });
    }) as typeof fetch;

    const pending = runDownloadWorker({
      dataDir,
      kind: "chat",
      modelId: VISION.id,
      mode: "with-mmproj",
      log: (l) => log.push(l),
      writeIntervalMs: 0,
    });
    await waitFor(() => releaseGguf !== null);
    releaseGguf?.();
    const outcome = await pending;

    expect(outcome).toBe("done");
    const job = readDownloadJob(dataDir, downloadJobId("chat", VISION.id));
    expect(job?.status).toBe("done");
    expect(job?.error).toBeNull();
    expect(job?.mmprojError).toMatch(/HTTP 404/);
    const dest = resolveModelFilePath(dataDir, VISION.id, VISION.filename);
    expect(readFileSync(dest, "utf-8")).toBe("abcd");
    expect(existsSync(resolvePartialPath(dest))).toBe(false);
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
    expect(job.totalBytes).toBe(
      gb(VISION.fileSizeGb) + gb(VISION.mmprojFileSizeGb ?? 1),
    );
  });

  it("initialDownloadJob reports the partial already on disk instead of 0%", () => {
    const dest = resolveModelFilePath(dataDir, CHAT.id, CHAT.filename);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(resolvePartialPath(dest), Buffer.alloc(250));
    writeFileSync(
      resolvePartialMetaPath(dest),
      JSON.stringify({
        url: CHAT.huggingFaceUrl,
        total: 1000,
        etag: null,
        lastModified: null,
      }),
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
    expect(job.totalBytes).toBe(
      Math.round(EMB.fileSizeGb * 1024 * 1024 * 1024),
    );
    expect(job.label).toBe(EMB.name);
  });

  it("lands a vision model text-only when its projector fails after the GGUF", async () => {
    globalThis.fetch = fetchWithMissingProjector();

    const outcome = await runDownloadWorker({
      dataDir,
      kind: "chat",
      modelId: CHAT.id,
      mode: "with-mmproj",
      log: (l) => log.push(l),
      writeIntervalMs: 0,
    });

    expect(outcome).toBe("done");
    expect(
      readFileSync(
        resolveModelFilePath(dataDir, CHAT.id, CHAT.filename),
        "utf-8",
      ),
    ).toBe("gguf");
    expect(
      existsSync(resolveMmprojFilePath(dataDir, CHAT.id, CHAT.mmprojFilename!)),
    ).toBe(false);
    const job = readDownloadJob(dataDir, downloadJobId("chat", CHAT.id));
    // Done, but with the projector phase's honest numbers: nothing of
    // that file came, and the bar must not say 100% of it did.
    expect(job).toMatchObject({
      status: "done",
      error: null,
      phase: "mmproj",
      percent: 0,
    });
    expect(job?.mmprojError).toMatch(/HTTP 404/);
    expect(log.some((l) => /projector failed: .*404.*text-only/.test(l))).toBe(
      true,
    );
    expect(log.at(-1)).toMatch(/done — text-only/);
  });

  it("a projector-only pull with the weights on disk lands text-only too", async () => {
    const dest = resolveModelFilePath(dataDir, CHAT.id, CHAT.filename);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, "gguf");
    globalThis.fetch = fetchWithMissingProjector();

    const outcome = await runDownloadWorker({
      dataDir,
      kind: "chat",
      modelId: CHAT.id,
      mode: "mmproj-only",
      log: (l) => log.push(l),
      writeIntervalMs: 0,
    });

    expect(outcome).toBe("done");
    const job = readDownloadJob(dataDir, downloadJobId("chat", CHAT.id));
    expect(job?.status).toBe("done");
    expect(job?.mmprojError).toMatch(/HTTP 404/);
  });

  it("a projector-only pull with no weights on disk still fails — nothing landed", async () => {
    globalThis.fetch = fetchWithMissingProjector();

    const outcome = await runDownloadWorker({
      dataDir,
      kind: "chat",
      modelId: CHAT.id,
      mode: "mmproj-only",
      log: (l) => log.push(l),
      writeIntervalMs: 0,
    });

    expect(outcome).toBe("failed");
    const job = readDownloadJob(dataDir, downloadJobId("chat", CHAT.id));
    expect(job?.status).toBe("failed");
    expect(job?.error).toMatch(/HTTP 404/);
    expect(job?.mmprojError).toBeUndefined();
  });

  it("a cancel during the projector phase is still a cancel, never a text-only landing", async () => {
    let release: (() => void) | null = null;
    // Built inside the mock, not up front: a ReadableStream pulls its
    // first chunk on construction, and the abort must land in the
    // projector phase, after the GGUF has been written whole.
    const gated = (): ReadableStream =>
      new ReadableStream({
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
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return url.includes("mmproj")
        ? new Response(gated(), {
            status: 200,
            headers: { "content-length": "4" },
          })
        : new Response(bodyOf(["gg", "uf"]), {
            status: 200,
            headers: { "content-length": "4" },
          });
    }) as typeof fetch;

    const controller = new AbortController();
    const pending = runDownloadWorker({
      dataDir,
      kind: "chat",
      modelId: CHAT.id,
      mode: "with-mmproj",
      signal: controller.signal,
      log: (l) => log.push(l),
      writeIntervalMs: 0,
    });
    const mmproj = resolveMmprojFilePath(
      dataDir,
      CHAT.id,
      CHAT.mmprojFilename!,
    );
    // Cancel once the weights have landed AND the projector's first
    // bytes are on disk: the two files stream side by side now (the
    // paired pull), so waiting only on the projector could catch the
    // GGUF mid-flight and the assertions below would be about a
    // different scenario.
    await waitFor(
      () =>
        existsSync(resolveModelFilePath(dataDir, CHAT.id, CHAT.filename)) &&
        existsSync(resolvePartialPath(mmproj)) &&
        readFileSync(resolvePartialPath(mmproj), "utf-8") === "ab",
    );
    controller.abort();
    release?.();

    expect(await pending).toBe("cancelled");
    const job = readDownloadJob(dataDir, downloadJobId("chat", CHAT.id));
    expect(job?.status).toBe("cancelled");
    expect(job?.mmprojError).toBeUndefined();
    // The weights landed before the cancel; the projector partial is kept.
    expect(
      readFileSync(
        resolveModelFilePath(dataDir, CHAT.id, CHAT.filename),
        "utf-8",
      ),
    ).toBe("gguf");
    expect(existsSync(mmproj)).toBe(false);
    expect(readFileSync(resolvePartialPath(mmproj), "utf-8")).toBe("ab");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}
