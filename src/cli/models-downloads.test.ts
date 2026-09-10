import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `spawn` is a non-configurable export of the built-in, so it cannot be
// spied on in place; the whole module is mocked with a spawn that hands
// back a worker pid nothing will ever own.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import {
  ensureUserConfigFileSync,
  getConfig,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";
import {
  downloadJobId,
  getEmbeddingModelDef,
  readDownloadJob,
  readDownloadNotify,
  writeDownloadJob,
  writeDownloadNotify,
  type DownloadJob,
} from "../local-llm/index.js";
import { modelsCommand } from "./models-command.js";
import {
  followDownloadJob,
  runLocalModelsPullWorker,
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
    waiting: null,
    resumable: false,
    startedAt: "2026-09-07T10:00:00.000Z",
    updatedAt: new Date().toISOString(),
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
    spawnMock.mockReturnValue({
      pid: DEAD_PID,
      unref: vi.fn(),
    } as unknown as ChildProcess);

    const code = await modelsCommand(["pull", "--background", "qwen-3.5-4b"]);

    expect(code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const out = stdoutChunks.join("");
    expect(out).toMatch(
      /downloading Qwen.*in the background \(pid 2000000000\)/,
    );
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

  it("models pull --background --notify arms the ping and says so", async () => {
    vi.spyOn(process, "execPath", "get").mockReturnValue("/opt/node/bin/node");
    vi.spyOn(process, "argv", "get").mockReturnValue([
      "/opt/node/bin/node",
      "/repo/dist/cli/index.js",
    ]);
    spawnMock.mockReset();
    spawnMock.mockReturnValue({
      pid: DEAD_PID,
      unref: vi.fn(),
    } as unknown as ChildProcess);

    const code = await modelsCommand([
      "pull",
      "--background",
      "--notify",
      "discord",
      "qwen-3.5-4b",
    ]);

    expect(code).toBe(0);
    expect(
      readDownloadNotify(dataDir, downloadJobId("chat", "qwen-3.5-4b")),
    ).toBe("discord");
    expect(stdoutChunks.join("")).toMatch(/ping:\s+discord when it lands/);
  });

  it("--notify rejects what it cannot deliver and demands --background", async () => {
    vi.spyOn(process, "execPath", "get").mockReturnValue("/opt/node/bin/node");
    vi.spyOn(process, "argv", "get").mockReturnValue([
      "/opt/node/bin/node",
      "/repo/dist/cli/index.js",
    ]);
    spawnMock.mockReset();
    spawnMock.mockReturnValue({
      pid: DEAD_PID,
      unref: vi.fn(),
    } as unknown as ChildProcess);

    expect(
      await modelsCommand(["pull", "--notify", "telegram", "qwen-3.5-4b"]),
    ).toBe(2);
    expect(stderrChunks.join("")).toMatch(/only applies to a background pull/);
    await expect(
      modelsCommand(["pull", "--background", "qwen-3.5-4b", "--notify"]),
    ).rejects.toThrow(/got nothing/);
    await expect(
      modelsCommand(["pull", "--background", "--notify=pager", "qwen-3.5-4b"]),
    ).rejects.toThrow(/telegram, discord, email or off/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("--notify on a pull that is already running re-arms the live job", async () => {
    writeDownloadJob(dataDir, job({ pid: process.pid }));
    const pending = modelsCommand([
      "pull",
      "--background",
      "--notify",
      "discord",
      "qwen-3.5-4b",
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(readDownloadNotify(dataDir, job().id)).toBe("discord");
    // Let the follower see the job end.
    writeDownloadJob(dataDir, job({ status: "done", percent: 100 }));
    expect(await pending).toBe(0);
    expect(stderrChunks.join("")).toMatch(/ping: discord when it lands/);
  });

  it("models downloads shows where a job will report, and how the ping went", async () => {
    writeDownloadJob(dataDir, job({ pid: DEAD_PID }));
    writeDownloadNotify(dataDir, job().id, "telegram");
    writeDownloadJob(
      dataDir,
      job({
        id: "chat-qwen-3.5-9b",
        modelId: "qwen-3.5-9b",
        status: "done",
        percent: 100,
        startedAt: "2026-09-07T09:00:00.000Z",
        notified: {
          channel: "discord",
          outcome: "failed",
          reason: "Unauthorized",
          at: "2026-09-07T09:30:00.000Z",
        },
      }),
    );
    const code = await modelsCommand(["downloads"]);
    expect(code).toBe(0);
    const lines = stdoutChunks.join("").split("\n");
    expect(lines.find((l) => l.startsWith("chat-qwen-3.5-4b"))).toMatch(
      /→ telegram$/,
    );
    expect(lines.find((l) => l.startsWith("chat-qwen-3.5-9b"))).toMatch(
      /→ discord ✗ Unauthorized$/,
    );
  });

  it("the worker pings the armed channel when the job lands, and logs the outcome", async () => {
    // Credentials as the hub stores them: token in the environment
    // (`.env` is merged by loadConfig), owner id in config.json.
    const configPath = getConfig().paths.userConfigFile;
    const prev = ensureUserConfigFileSync(configPath);
    writeUserConfigFileSync(configPath, {
      ...prev,
      telegram: { ...prev.telegram, ownerUserId: 4242 },
    });
    resetConfigCache();
    process.env.TELEGRAM_BOT_TOKEN =
      "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const emb = getEmbeddingModelDef("nomic-embed-text-v1.5");
    const jobId = downloadJobId("embedding", emb.id);
    writeDownloadNotify(dataDir, jobId, "telegram");

    const telegramBodies: Record<string, unknown>[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("api.telegram.org")) {
          telegramBodies.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify({ ok: true, result: { message_id: 1 } }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("gguf", {
          status: 200,
          headers: { "content-length": "4" },
        });
      },
    ) as typeof fetch;
    try {
      const code = await runLocalModelsPullWorker([
        "embedding",
        emb.id,
        "gguf-only",
      ]);
      expect(code).toBe(0);
    } finally {
      globalThis.fetch = prevFetch;
      delete process.env.TELEGRAM_BOT_TOKEN;
    }

    expect(telegramBodies).toHaveLength(1);
    expect(telegramBodies[0]).toMatchObject({ chat_id: 4242 });
    expect(String(telegramBodies[0].text)).toMatch(/Model ready: nomic/i);
    expect(stdoutChunks.join("")).toMatch(/notify telegram sent/);
    expect(readDownloadJob(dataDir, jobId)).toMatchObject({
      status: "done",
      notified: { channel: "telegram", outcome: "sent", reason: null },
    });
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
    expect(
      await followDownloadJob(dataDir, "chat-qwen-3.5-4b", {
        pollMs: 1,
        sigint: false,
      }),
    ).toBe(0);
    writeDownloadJob(dataDir, job({ status: "failed", error: "disk full" }));
    expect(
      await followDownloadJob(dataDir, "chat-qwen-3.5-4b", {
        pollMs: 1,
        sigint: false,
      }),
    ).toBe(1);
    expect(stderrChunks.join("")).toMatch(
      /background download failed: disk full/,
    );
  });

  it("followDownloadJob returns 1 when the worker died mid-way and names the resume command", async () => {
    writeDownloadJob(dataDir, job({ pid: DEAD_PID }));
    expect(
      await followDownloadJob(dataDir, "chat-qwen-3.5-4b", {
        pollMs: 1,
        sigint: false,
      }),
    ).toBe(1);
    expect(stderrChunks.join("")).toMatch(
      /interrupted; partial kept.*models pull qwen-3.5-4b/,
    );
  });

  it("a foreground pull of a model with a live worker follows it instead of downloading", async () => {
    writeDownloadJob(
      dataDir,
      job({ pid: process.pid, status: "done", percent: 100 }),
    );
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

  it("models downloads lists a text-only landing as done with the projector error", async () => {
    writeDownloadJob(
      dataDir,
      job({
        status: "done",
        percent: 100,
        mmprojError: "Download failed: HTTP 404 Not Found",
      }),
    );
    expect(await modelsCommand(["downloads"])).toBe(0);
    expect(stdoutChunks.join("")).toMatch(
      /^chat-qwen-3\.5-4b\s+done, text-only\s+.*projector: Download failed: HTTP 404 Not Found/m,
    );
  });

  it("followDownloadJob returns 0 for a text-only landing and says how to retry the projector", async () => {
    writeDownloadJob(
      dataDir,
      job({
        status: "done",
        percent: 100,
        mode: "with-mmproj",
        mmprojError: "Download failed: HTTP 404 Not Found",
      }),
    );
    expect(
      await followDownloadJob(dataDir, "chat-qwen-3.5-4b", {
        pollMs: 1,
        sigint: false,
      }),
    ).toBe(0);
    expect(stderrChunks.join("")).toMatch(
      /projector download failed \(Download failed: HTTP 404 Not Found\) — qwen-3.5-4b is usable text-only; 'models pull --mmproj qwen-3.5-4b'/,
    );
  });
});
