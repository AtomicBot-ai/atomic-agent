import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  downloadJobId,
  isDownloadJobLive,
  listDownloadJobs,
  readDownloadJob,
  reconcileDownloadJob,
  removeDownloadJob,
  resolveDownloadJobPath,
  resolveDownloadLogPath,
  resolveDownloadsDir,
  writeDownloadJob,
  type DownloadJob,
} from "./download-jobs.js";

/** A pid no process on any supported OS is handed out. */
const DEAD_PID = 2_000_000_000;

function job(patch: Partial<DownloadJob> = {}): DownloadJob {
  return {
    version: 1,
    id: downloadJobId("chat", "qwen-3.5-4b"),
    kind: "chat",
    modelId: "qwen-3.5-4b",
    mode: "gguf-only",
    pid: process.pid,
    status: "running",
    phase: "gguf",
    label: "Qwen 3.5 4B (gguf)",
    percent: 12,
    transferredBytes: 1200,
    totalBytes: 10_000,
    error: null,
    startedAt: "2026-09-07T10:00:00.000Z",
    updatedAt: "2026-09-07T10:00:05.000Z",
    finishedAt: null,
    ...patch,
  };
}

describe("download-jobs", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "atomic-dl-jobs-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("names paths under <dataDir>/downloads and ids by kind + model", () => {
    expect(resolveDownloadsDir(dataDir)).toBe(join(dataDir, "downloads"));
    expect(downloadJobId("embedding", "nomic-embed-text-v1.5")).toBe(
      "embedding-nomic-embed-text-v1.5",
    );
    expect(resolveDownloadJobPath(dataDir, "chat-x")).toBe(
      join(dataDir, "downloads", "chat-x.json"),
    );
    expect(resolveDownloadLogPath(dataDir, "chat-x")).toBe(
      join(dataDir, "downloads", "chat-x.log"),
    );
  });

  it("round-trips a record and leaves no temp file behind", () => {
    const j = job();
    writeDownloadJob(dataDir, j);
    expect(readDownloadJob(dataDir, j.id)).toEqual(j);
    expect(readdirSync(resolveDownloadsDir(dataDir))).toEqual([`${j.id}.json`]);
  });

  it("returns null for a missing, malformed or foreign-version record", () => {
    expect(readDownloadJob(dataDir, "nope")).toBeNull();
    writeDownloadJob(dataDir, job({ id: "ok" }));
    writeFileSync(resolveDownloadJobPath(dataDir, "bad"), "{not json");
    writeFileSync(
      resolveDownloadJobPath(dataDir, "v9"),
      JSON.stringify({ ...job({ id: "v9" }), version: 9 }),
    );
    expect(readDownloadJob(dataDir, "bad")).toBeNull();
    expect(readDownloadJob(dataDir, "v9")).toBeNull();
    expect(listDownloadJobs(dataDir).map((j) => j.id)).toEqual(["ok"]);
  });

  it("reports a running job whose worker died as interrupted, and persists that", () => {
    const j = job({ pid: DEAD_PID });
    writeDownloadJob(dataDir, j);
    const seen = readDownloadJob(dataDir, j.id);
    expect(seen?.status).toBe("interrupted");
    expect(seen?.error).toBe("worker process is gone");
    expect(seen?.finishedAt).toBe(j.updatedAt);
    // Written back: a second reader agrees without re-probing the pid.
    expect(JSON.parse(readFileSync(resolveDownloadJobPath(dataDir, j.id), "utf-8")).status).toBe(
      "interrupted",
    );
    expect(isDownloadJobLive(seen)).toBe(false);
  });

  it("keeps a running job whose worker is alive (this process) as running", () => {
    const j = job({ pid: process.pid });
    writeDownloadJob(dataDir, j);
    const seen = readDownloadJob(dataDir, j.id);
    expect(seen?.status).toBe("running");
    expect(isDownloadJobLive(seen)).toBe(true);
  });

  it("reconcileDownloadJob only touches running jobs", () => {
    const dead = (): boolean => false;
    expect(reconcileDownloadJob(job({ status: "done", pid: DEAD_PID }), dead).status).toBe(
      "done",
    );
    expect(reconcileDownloadJob(job({ status: "failed", error: "x" }), dead).error).toBe("x");
    const interrupted = reconcileDownloadJob(job(), dead);
    expect(interrupted.status).toBe("interrupted");
    // The original error, when there is one, is not overwritten.
    expect(reconcileDownloadJob(job({ error: "kept" }), dead).error).toBe("kept");
  });

  it("lists newest start first and removeDownloadJob drops record + log", () => {
    writeDownloadJob(dataDir, job({ id: "a", startedAt: "2026-09-07T09:00:00.000Z" }));
    writeDownloadJob(dataDir, job({ id: "b", startedAt: "2026-09-07T11:00:00.000Z" }));
    writeFileSync(resolveDownloadLogPath(dataDir, "b"), "log");
    expect(listDownloadJobs(dataDir).map((j) => j.id)).toEqual(["b", "a"]);
    removeDownloadJob(dataDir, "b");
    expect(existsSync(resolveDownloadJobPath(dataDir, "b"))).toBe(false);
    expect(existsSync(resolveDownloadLogPath(dataDir, "b"))).toBe(false);
    expect(listDownloadJobs(dataDir).map((j) => j.id)).toEqual(["a"]);
  });
});
