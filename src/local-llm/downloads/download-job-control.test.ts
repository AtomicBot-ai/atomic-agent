import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveModelFilePath,
  resolveMmprojFilePath,
} from "../backend-paths.js";
import { getLocalModelDef, listLocalModels } from "../catalog/models-catalog.js";
import {
  cancelDownloadJob,
  downloadJobPartialPaths,
  pauseDownloadJob,
  resumeDownloadJob,
} from "./download-job-control.js";
import { isDownloadJobStale } from "./download-job-staleness.js";
import {
  downloadJobId,
  readDownloadJob,
  reconcileDownloadJob,
  writeDownloadJob,
  type DownloadJob,
} from "./download-jobs.js";
import {
  resolvePartialMetaPath,
  resolvePartialPath,
  writePartialMeta,
} from "./download-partial.js";
import { spawnDownloadWorker } from "./download-spawn.js";

/** Above the Linux pid ceiling: nothing can hold it. */
const DEAD_PID = 2_000_000_000;
const MODEL = "qwen-3.5-4b";

function job(patch: Partial<DownloadJob> = {}): DownloadJob {
  return {
    version: 1,
    id: downloadJobId("chat", MODEL),
    kind: "chat",
    modelId: MODEL,
    mode: "gguf-only",
    // Our own pid reads as alive, so the record stays `running`; the
    // stop is always the `stop` seam, never a real signal.
    pid: process.pid,
    status: "running",
    phase: "gguf",
    label: "Qwen 3.5 4B (gguf)",
    percent: 40,
    transferredBytes: 4_096,
    totalBytes: 10_240,
    error: null,
    waiting: null,
    resumable: false,
    startedAt: "2026-11-12T10:00:00.000Z",
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    ...patch,
  };
}

describe("download job control: pause, resume, cancel", () => {
  let dataDir: string;
  let dest: string;

  /** A resumable partial holding the first `bytes` bytes of the GGUF. */
  function writePartial(bytes: number, total = 10_240): void {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(resolvePartialPath(dest), Buffer.alloc(bytes, 1));
    writePartialMeta(dest, {
      url: "https://example.test/model.gguf",
      total,
      etag: '"abc"',
      lastModified: null,
      done: [[0, bytes]],
    });
  }

  /** What the worker's SIGTERM handler leaves: a `cancelled` record. */
  const stopAs = (patch: Partial<DownloadJob>) =>
    vi.fn(async (dir: string, j: DownloadJob) => {
      const after = { ...j, ...patch };
      writeDownloadJob(dir, after);
      return { outcome: "stopped" as const, job: after };
    });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "atomic-dl-control-"));
    const def = getLocalModelDef(MODEL);
    dest = resolveModelFilePath(dataDir, def.id, def.filename);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("pause stops the worker, keeps the partial and records paused", async () => {
    writePartial(4_096);
    const running = job();
    writeDownloadJob(dataDir, running);
    const stop = stopAs({ status: "cancelled", finishedAt: "x" });

    const result = await pauseDownloadJob(dataDir, running, { stop });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("paused");
    expect(existsSync(resolvePartialPath(dest))).toBe(true);
    expect(existsSync(resolvePartialMetaPath(dest))).toBe(true);
    expect(readDownloadJob(dataDir, running.id)).toMatchObject({
      status: "paused",
      percent: 40,
      transferredBytes: 4_096,
      waiting: null,
    });
  });

  it("a paused record survives a restart: never reconciled, never stale", async () => {
    const paused = job({
      status: "paused",
      pid: DEAD_PID,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    writeDownloadJob(dataDir, paused);
    // A later process reads it back: the dead pid does not turn it
    // into `interrupted`, so nothing auto-resumes it.
    expect(reconcileDownloadJob(paused, () => false)).toBe(paused);
    expect(readDownloadJob(dataDir, paused.id)?.status).toBe("paused");
    expect(isDownloadJobStale(paused, Date.parse("2026-12-01T00:00:00.000Z"))).toBe(false);
  });

  it("pause marks an interrupted job paused without signalling anything", async () => {
    writePartial(4_096);
    const interrupted = job({ status: "interrupted", pid: DEAD_PID });
    writeDownloadJob(dataDir, interrupted);
    const stop = vi.fn();

    const result = await pauseDownloadJob(dataDir, interrupted, { stop });

    expect(stop).not.toHaveBeenCalled();
    expect(result.outcome).toBe("paused");
    expect(existsSync(resolvePartialPath(dest))).toBe(true);
  });

  it("pause leaves a job that landed before the stop reached it as done", async () => {
    const running = job();
    writeDownloadJob(dataDir, running);
    const stop = stopAs({ status: "done", percent: 100 });

    const result = await pauseDownloadJob(dataDir, running, { stop });

    expect(result.outcome).toBe("not-running");
    expect(readDownloadJob(dataDir, running.id)?.status).toBe("done");
  });

  it("pause on a worker that ignores the stop changes nothing", async () => {
    writePartial(4_096);
    const running = job();
    writeDownloadJob(dataDir, running);
    const stop = vi.fn(async () => ({
      outcome: "still-running" as const,
      job: running,
    }));

    const result = await pauseDownloadJob(dataDir, running, { stop });

    expect(result.outcome).toBe("still-running");
    expect(readDownloadJob(dataDir, running.id)?.status).toBe("running");
  });

  it("resume relaunches the worker from the partial's offset", () => {
    writePartial(4_096);
    const paused = job({ status: "paused", pid: DEAD_PID });
    writeDownloadJob(dataDir, paused);
    const fakeSpawn = vi.fn(
      () => ({ pid: DEAD_PID, unref: vi.fn() }) as unknown as ChildProcess,
    );

    const result = resumeDownloadJob(dataDir, paused, {
      spawn: (input) =>
        spawnDownloadWorker({
          ...input,
          spawn: fakeSpawn as unknown as typeof nodeSpawn,
          execPath: "/opt/node/bin/node",
          argv: ["/opt/node/bin/node", "/repo/dist/cli/index.js"],
          execArgv: [],
          sea: false,
        }),
    });

    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("spawned");
    if (result.outcome !== "spawned") return;
    // The new worker opens on the bytes already on disk, not on 0%;
    // its transfer asks for the rest with `Range: bytes=4096-`
    // (covered in download-file.test.ts).
    expect(result.job).toMatchObject({
      status: "running",
      transferredBytes: 4_096,
      totalBytes: 10_240,
      percent: 40,
    });
    expect(existsSync(resolvePartialPath(dest))).toBe(true);
  });

  it("resume refuses a finished job", () => {
    const spawn = vi.fn();
    const result = resumeDownloadJob(dataDir, job({ status: "done" }), {
      spawn: spawn as unknown as typeof spawnDownloadWorker,
    });
    expect(result.outcome).toBe("not-resumable");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("cancel stops the worker and deletes the partial", async () => {
    writePartial(4_096);
    const running = job();
    writeDownloadJob(dataDir, running);
    const stop = stopAs({ status: "cancelled" });

    const result = await cancelDownloadJob(dataDir, running, { stop });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("cancelled");
    expect(existsSync(resolvePartialPath(dest))).toBe(false);
    expect(existsSync(resolvePartialMetaPath(dest))).toBe(false);
    expect(readDownloadJob(dataDir, running.id)).toMatchObject({
      status: "cancelled",
      percent: 0,
      transferredBytes: 0,
    });
  });

  it("cancel throws away a paused download", async () => {
    writePartial(4_096);
    const paused = job({ status: "paused", pid: DEAD_PID });
    writeDownloadJob(dataDir, paused);
    const stop = vi.fn();

    const result = await cancelDownloadJob(dataDir, paused, { stop });

    expect(stop).not.toHaveBeenCalled();
    expect(result.outcome).toBe("cancelled");
    expect(existsSync(resolvePartialPath(dest))).toBe(false);
  });

  it("cancel keeps the partial while a worker that ignored the stop still writes to it", async () => {
    writePartial(4_096);
    const running = job();
    writeDownloadJob(dataDir, running);
    const stop = vi.fn(async () => ({
      outcome: "still-running" as const,
      job: running,
    }));

    const result = await cancelDownloadJob(dataDir, running, { stop });

    expect(result.outcome).toBe("still-running");
    expect(existsSync(resolvePartialPath(dest))).toBe(true);
  });

  it("cancel never touches a finished job's files", async () => {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, "weights");
    const result = await cancelDownloadJob(dataDir, job({ status: "done" }));
    expect(result.outcome).toBe("not-running");
    expect(existsSync(dest)).toBe(true);
  });

  it("partial paths follow the job's mode", () => {
    const vision = listLocalModels().find(
      (m) => m.supportsVision && m.mmprojFilename && !m.localPath,
    );
    if (!vision) return;
    const gguf = resolveModelFilePath(dataDir, vision.id, vision.filename);
    const mmproj = resolveMmprojFilePath(
      dataDir,
      vision.id,
      vision.mmprojFilename ?? "",
    );
    const at = (mode: DownloadJob["mode"]) =>
      downloadJobPartialPaths(dataDir, { kind: "chat", modelId: vision.id, mode });
    expect(at("gguf-only")).toEqual([gguf]);
    expect(at("mmproj-only")).toEqual([mmproj]);
    expect(at("with-mmproj")).toEqual([gguf, mmproj]);
    expect(
      downloadJobPartialPaths(dataDir, {
        kind: "chat",
        modelId: "no-such-model",
        mode: "gguf-only",
      }),
    ).toEqual([]);
  });
});
