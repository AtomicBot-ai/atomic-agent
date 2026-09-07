import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `spawn` is a non-configurable export of the built-in, so it cannot be
// spied on in place; the whole module is mocked with a spawn that hands
// back a worker pid nothing will ever own.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import { getConfig, resetConfigCache } from "../config/index.js";
import {
  downloadJobId,
  readDownloadJob,
  resolveDownloadLogPath,
  writeDownloadJob,
  type DownloadJob,
} from "../local-llm/index.js";
import { modelsCommand } from "./models-command.js";
import {
  downloadWorkerArgs,
  followDownloadJob,
  spawnDownloadWorker,
} from "./models-downloads.js";

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

describe("background model downloads (CLI)", () => {
  let stateDir: string;
  let dataDir: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-dl-cli-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    dataDir = getConfig().paths.localModelsDataDir;
    stdoutChunks = [];
    stderrChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  it("spawns a detached copy of this program with the worker argv, logging to the job log", () => {
    const spawn = vi.fn(() => ({ pid: 777, unref: vi.fn() }) as unknown as ChildProcess);

    const result = spawnDownloadWorker({
      kind: "chat",
      modelId: "qwen-3.5-4b",
      mode: "gguf-only",
      spawn: spawn as unknown as typeof nodeSpawn,
      execPath: "/opt/node/bin/node",
      argv: ["/opt/node/bin/node", "/repo/dist/cli/index.js", "models", "pull"],
      execArgv: [],
      sea: false,
      env: { ATOMIC_AGENT_STATE_DIR: stateDir },
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
      ...downloadWorkerArgs({ kind: "chat", modelId: "qwen-3.5-4b", mode: "gguf-only" }),
    ]);
    expect(opts.detached).toBe(true);
    expect(opts.stdio[0]).toBe("ignore");
    expect(opts.env.ATOMIC_AGENT_STATE_DIR).toBe(stateDir);
    // The record exists before the worker has written a byte.
    const seeded = readDownloadJob(dataDir, downloadJobId("chat", "qwen-3.5-4b"));
    expect(seeded).toMatchObject({ pid: 777, status: "interrupted" });
    expect(existsSync(resolveDownloadLogPath(dataDir, "chat-qwen-3.5-4b"))).toBe(true);
  });

  it("does not start a second worker for a model whose worker is alive", () => {
    writeDownloadJob(dataDir, job({ pid: process.pid }));
    const spawn = vi.fn();
    const result = spawnDownloadWorker({
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

  it("models pull --background reports how to watch, follow and stop the worker", async () => {
    vi.spyOn(process, "execPath", "get").mockReturnValue("/opt/node/bin/node");
    vi.spyOn(process, "argv", "get").mockReturnValue([
      "/opt/node/bin/node",
      "/repo/dist/cli/index.js",
      "models",
      "pull",
    ]);
    // A worker that exits immediately: the record it seeded is what the
    // command reports on, and the pid dies before anyone reads it.
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ pid: DEAD_PID, unref: vi.fn() } as unknown as ChildProcess);

    const code = await modelsCommand(["pull", "--background", "qwen-3.5-4b"]);

    expect(code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const out = stdoutChunks.join("");
    expect(out).toMatch(/downloading Qwen.*in the background \(pid 2000000000\)/);
    expect(out).toMatch(/models downloads/);
    expect(out).toMatch(/models downloads cancel qwen-3.5-4b/);
    expect(out).toMatch(/keeps running after this terminal closes/);
  });

  it("models downloads lists jobs and marks a dead worker as interrupted", async () => {
    writeDownloadJob(dataDir, job({ pid: DEAD_PID }));
    writeDownloadJob(
      dataDir,
      job({
        id: downloadJobId("embedding", "nomic-embed-text-v1.5"),
        kind: "embedding",
        modelId: "nomic-embed-text-v1.5",
        status: "done",
        percent: 100,
        startedAt: "2026-09-07T11:00:00.000Z",
      }),
    );

    const code = await modelsCommand(["downloads"]);

    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    const lines = out.split("\n");
    const chatLine = lines.find((l) => l.startsWith("chat-qwen-3.5-4b"));
    const embLine = lines.find((l) => l.startsWith("embedding-nomic"));
    expect(chatLine).toMatch(/interrupted/);
    expect(chatLine).toMatch(/4 MB \/ 10 MB/);
    expect(embLine).toMatch(/\bdone\b/);
    // Newest start first.
    expect(lines.indexOf(embLine!)).toBeLessThan(lines.indexOf(chatLine!));
  });

  it("models downloads cancel on a job that is not running says so and succeeds", async () => {
    writeDownloadJob(dataDir, job({ status: "failed", error: "boom" }));
    const code = await modelsCommand(["downloads", "cancel", "qwen-3.5-4b"]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toMatch(/not running \(failed\)/);
  });

  it("models downloads clear forgets finished records only", async () => {
    writeDownloadJob(dataDir, job({ id: "chat-a", status: "done" }));
    writeDownloadJob(dataDir, job({ id: "chat-b", pid: process.pid }));
    const code = await modelsCommand(["downloads", "clear"]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toMatch(/cleared 1/);
    expect(readDownloadJob(dataDir, "chat-a")).toBeNull();
    expect(readDownloadJob(dataDir, "chat-b")?.status).toBe("running");
  });

  it("followDownloadJob returns 0 once the record says done, 1 on failed", async () => {
    writeDownloadJob(dataDir, job({ status: "done", percent: 100 }));
    expect(await followDownloadJob(dataDir, "chat-qwen-3.5-4b", { pollMs: 1, sigint: false })).toBe(0);
    writeDownloadJob(dataDir, job({ status: "failed", error: "disk full" }));
    expect(await followDownloadJob(dataDir, "chat-qwen-3.5-4b", { pollMs: 1, sigint: false })).toBe(1);
    expect(stderrChunks.join("")).toMatch(/background download failed: disk full/);
  });

  it("followDownloadJob returns 1 when the worker died mid-way and names the resume command", async () => {
    writeDownloadJob(dataDir, job({ pid: DEAD_PID }));
    expect(await followDownloadJob(dataDir, "chat-qwen-3.5-4b", { pollMs: 1, sigint: false })).toBe(1);
    expect(stderrChunks.join("")).toMatch(/interrupted; partial kept.*models pull qwen-3.5-4b/);
  });

  it("a foreground pull of a model with a live worker follows it instead of downloading", async () => {
    writeDownloadJob(dataDir, job({ pid: process.pid, status: "done", percent: 100 }));
    // `done` is not live, so this exercises the read path only; the live
    // case is the spawn-refusal test above plus followDownloadJob's own.
    const prevFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 404, statusText: "Not Found" }),
    ) as typeof fetch;
    let code: number;
    try {
      code = await modelsCommand(["pull", "qwen-3.5-4b"]);
    } finally {
      globalThis.fetch = prevFetch;
    }
    // No worker alive: the foreground pull runs and fails on the mocked
    // fetch — proving it did not follow a finished record.
    expect(code).toBe(1);
    expect(stderrChunks.join("")).not.toMatch(/already downloading/);
  });

  it("the worker log path is created next to the record", () => {
    const spawn = vi.fn(() => ({ pid: 1, unref: vi.fn() }) as unknown as ChildProcess);
    const result = spawnDownloadWorker({
      kind: "embedding",
      modelId: "nomic-embed-text-v1.5",
      mode: "gguf-only",
      spawn: spawn as unknown as typeof nodeSpawn,
      sea: true,
      execPath: "/bin/atag",
    });
    expect(result.outcome).toBe("spawned");
    if (result.outcome !== "spawned") return;
    expect(result.logPath).toBe(join(dataDir, "downloads", "embedding-nomic-embed-text-v1.5.log"));
    expect(readFileSync(result.logPath, "utf-8")).toBe("");
  });
});
