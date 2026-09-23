import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  downloadJobId,
  readDownloadJob,
  resolveDownloadLogPath,
  writeDownloadJob,
  type DownloadJob,
} from "./download-jobs.js";
import { readDownloadNotify } from "./download-notify-file.js";
import {
  downloadWorkerArgs,
  spawnDownloadWorker,
  stopDownloadWorker,
} from "./download-spawn.js";

const DEAD_PID = 2_000_000_000;

/**
 * The pid the fake spawn reports.
 *
 * `DEAD_PID`, not a small round number: `readDownloadJob` reclassifies a
 * `running` record whose pid is gone as `interrupted`, so a test that
 * asserts `interrupted` is asserting that this pid is dead. The value
 * used to be 777, which is dead on a developer's laptop and alive often
 * enough on a busy CI container to fail the run about one time in three
 * — the assertion read `expected { version: 1, … } to match { pid: 777,
 * status: 'interrupted' }` because the record came back `running`.
 * Above the 4,194,304 ceiling Linux will hand out, so nothing can hold
 * it.
 */
const SPAWNED_PID = DEAD_PID;

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
    percent: 40,
    transferredBytes: 4_000_000,
    totalBytes: 10_000_000,
    error: null,
    startedAt: "2026-09-07T10:00:00.000Z",
    updatedAt: "2026-09-07T10:00:05.000Z",
    finishedAt: null,
    ...patch,
  };
}

describe("download-spawn", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "atomic-dl-spawn-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("arms, keeps or disarms the end-of-job ping beside the record", () => {
    const spawn = vi.fn(
      () => ({ pid: SPAWNED_PID, unref: vi.fn() }) as unknown as ChildProcess,
    );
    const base = {
      dataDir,
      kind: "chat" as const,
      modelId: "qwen-3.5-4b",
      mode: "gguf-only" as const,
      spawn: spawn as unknown as typeof nodeSpawn,
      execPath: "/opt/node/bin/node",
      argv: ["/opt/node/bin/node", "/repo/dist/cli/index.js"],
      execArgv: [],
      sea: false,
      env: {},
    };
    const jobId = downloadJobId("chat", "qwen-3.5-4b");
    spawnDownloadWorker({ ...base, notify: "telegram" });
    expect(readDownloadNotify(dataDir, jobId)).toBe("telegram");
    // A relaunch onto the partial that says nothing keeps the ping.
    writeDownloadJob(dataDir, job({ pid: DEAD_PID }));
    spawnDownloadWorker(base);
    expect(readDownloadNotify(dataDir, jobId)).toBe("telegram");
    // An explicit null disarms it — even when the worker is already
    // running and nothing is spawned.
    writeDownloadJob(dataDir, job({ pid: process.pid }));
    expect(spawnDownloadWorker({ ...base, notify: null }).outcome).toBe(
      "already-running",
    );
    expect(readDownloadNotify(dataDir, jobId)).toBeNull();
  });

  it("spawns a detached copy of this program with the worker argv, logging to the job log", () => {
    const spawn = vi.fn(
      () => ({ pid: SPAWNED_PID, unref: vi.fn() }) as unknown as ChildProcess,
    );

    const result = spawnDownloadWorker({
      dataDir,
      kind: "chat",
      modelId: "qwen-3.5-4b",
      mode: "gguf-only",
      spawn: spawn as unknown as typeof nodeSpawn,
      execPath: "/opt/node/bin/node",
      argv: ["/opt/node/bin/node", "/repo/dist/cli/index.js", "models", "pull"],
      execArgv: [],
      sea: false,
      env: { ATOMIC_AGENT_STATE_DIR: "/state" },
    });

    expect(result.outcome).toBe("spawned");
    const [cmd, args, opts] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { detached: boolean; stdio: unknown[]; env: NodeJS.ProcessEnv },
    ];
    expect(cmd).toBe("/opt/node/bin/node");
    expect(args).toEqual([
      "/repo/dist/cli/index.js",
      ...downloadWorkerArgs({
        kind: "chat",
        modelId: "qwen-3.5-4b",
        mode: "gguf-only",
      }),
    ]);
    expect(opts.detached).toBe(true);
    expect(opts.stdio[0]).toBe("ignore");
    expect(opts.env.ATOMIC_AGENT_STATE_DIR).toBe("/state");
    // The record exists before the worker has written a byte.
    const seeded = readDownloadJob(
      dataDir,
      downloadJobId("chat", "qwen-3.5-4b"),
    );
    expect(seeded).toMatchObject({ pid: SPAWNED_PID, status: "interrupted" });
    expect(
      existsSync(resolveDownloadLogPath(dataDir, "chat-qwen-3.5-4b")),
    ).toBe(true);
  });

  it("does not start a second worker for a model whose worker is alive", () => {
    writeDownloadJob(dataDir, job({ pid: process.pid }));
    const spawn = vi.fn();
    const result = spawnDownloadWorker({
      dataDir,
      kind: "chat",
      modelId: "qwen-3.5-4b",
      mode: "gguf-only",
      spawn: spawn as unknown as typeof nodeSpawn,
      sea: true,
      execPath: "/bin/atag",
    });
    expect(result.outcome).toBe("already-running");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("the worker log path is created next to the record", () => {
    const spawn = vi.fn(
      () => ({ pid: 1, unref: vi.fn() }) as unknown as ChildProcess,
    );
    const result = spawnDownloadWorker({
      dataDir,
      kind: "embedding",
      modelId: "nomic-embed-text-v1.5",
      mode: "gguf-only",
      spawn: spawn as unknown as typeof nodeSpawn,
      sea: true,
      execPath: "/bin/atag",
    });
    expect(result.outcome).toBe("spawned");
    if (result.outcome !== "spawned") return;
    expect(result.logPath).toBe(
      join(dataDir, "downloads", "embedding-nomic-embed-text-v1.5.log"),
    );
    expect(readFileSync(result.logPath, "utf-8")).toBe("");
  });

  it("stopDownloadWorker is a no-op on a job that is not running", async () => {
    const j = job({ status: "failed", error: "x" });
    const kill = vi.fn();
    const result = await stopDownloadWorker(dataDir, j, { kill });
    expect(result.outcome).toBe("not-running");
    expect(kill).not.toHaveBeenCalled();
  });

  it("stopDownloadWorker signals the pid and resolves once the record leaves running", async () => {
    const j = job({ pid: process.pid });
    writeDownloadJob(dataDir, j);
    const kill = vi.fn((pid: number) => {
      expect(pid).toBe(process.pid);
      // What the worker's SIGTERM handler does: record the cancel.
      writeDownloadJob(dataDir, { ...j, status: "cancelled" });
    });
    const result = await stopDownloadWorker(dataDir, j, { kill, pollMs: 1 });
    expect(result).toMatchObject({
      outcome: "stopped",
      job: { status: "cancelled" },
    });
  });

  it("stopDownloadWorker reports a worker that ignores the stop", async () => {
    const j = job({ pid: process.pid });
    writeDownloadJob(dataDir, j);
    const result = await stopDownloadWorker(dataDir, j, {
      kill: () => undefined,
      pollMs: 1,
      timeoutMs: 20,
    });
    expect(result.outcome).toBe("still-running");
  });
});
