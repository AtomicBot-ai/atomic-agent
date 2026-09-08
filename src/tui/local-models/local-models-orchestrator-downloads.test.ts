import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfig, resetConfigCache } from "../../config/index.js";
import {
  downloadJobId,
  getEmbeddingModelDef,
  getLocalModelDef,
  initialDownloadJob,
  readDownloadJob,
  resolveBackendDir,
  resolveMmprojFilePath,
  resolveModelFilePath,
  resolvePartialMetaPath,
  resolvePartialPath,
  resolveServerBinPath,
  runDownloadWorker,
  writeDownloadJob,
  type DownloadJob,
  type SpawnDownloadWorkerInput,
  type SpawnDownloadWorkerResult,
  type StopDownloadWorkerResult,
} from "../../local-llm/index.js";
import { resolvePlatformAsset } from "../../local-llm/platform-assets.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

/**
 * The orchestrator never downloads in-process any more: it launches the
 * detached worker and watches its record. These tests substitute an
 * in-process worker for the spawn — same `runDownloadWorker`, same
 * record on disk, no child process — and drive `fetch` with the usual
 * mocks, so what is exercised is exactly the watch-and-land logic.
 */

type EmittedAction =
  | { type: string }
  | {
      type: "local_models_pull_started";
      pull: { modelId: string; label: string; percent: number };
    }
  | { type: "local_models_pull_failed"; kind: string; error: string }
  | { type: "runtime_info"; line: string };

function stubBackendInstalled(dataDir: string): void {
  const backendDir = resolveBackendDir(dataDir);
  mkdirSync(backendDir, { recursive: true });
  const { binaryName } = resolvePlatformAsset();
  writeFileSync(resolveServerBinPath(dataDir, binaryName), "");
}

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

/** A body that hands out one chunk, then waits to be released. */
function gatedBody(): { body: ReadableStream; release: () => void } {
  let release: (() => void) | null = null;
  let served = false;
  const body = new ReadableStream({
    async pull(controller) {
      if (!served) {
        served = true;
        controller.enqueue(Buffer.from("a"));
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        controller.enqueue(Buffer.from("b"));
        controller.close();
        return;
      }
      controller.close();
    },
  });
  return {
    body,
    release: () => {
      // Waits for the pull to have parked; the test always releases
      // after the first chunk has been observed.
      const tick = (): void => {
        if (release) release();
        else setTimeout(tick, 1);
      };
      tick();
    },
  };
}

/** Records written by the fake worker, plus a way to abort one. */
function inProcessWorker(): {
  spawnDownload: (input: SpawnDownloadWorkerInput) => SpawnDownloadWorkerResult;
  stopDownload: (dataDir: string, job: DownloadJob) => Promise<StopDownloadWorkerResult>;
  spawned: string[];
} {
  const controllers = new Map<string, AbortController>();
  const spawned: string[] = [];
  return {
    spawned,
    spawnDownload: (input) => {
      const jobId = downloadJobId(input.kind, input.modelId);
      const existing = readDownloadJob(input.dataDir, jobId);
      if (existing && existing.status === "running") {
        return { outcome: "already-running", job: existing };
      }
      spawned.push(jobId);
      const controller = new AbortController();
      controllers.set(jobId, controller);
      const job = initialDownloadJob({ ...input, pid: process.pid });
      writeDownloadJob(input.dataDir, job);
      void runDownloadWorker({
        dataDir: input.dataDir,
        kind: input.kind,
        modelId: input.modelId,
        mode: input.mode,
        signal: controller.signal,
        writeIntervalMs: 0,
        log: () => undefined,
      });
      return { outcome: "spawned", job, logPath: "" };
    },
    stopDownload: async (dataDir, job) => {
      controllers.get(job.id)?.abort();
      for (let i = 0; i < 200; i += 1) {
        const now = readDownloadJob(dataDir, job.id);
        if (!now || now.status !== "running") {
          return { outcome: "stopped", job: now ?? job };
        }
        await new Promise((r) => setTimeout(r, 2));
      }
      return { outcome: "still-running", job };
    },
  };
}

describe("LocalModelsOrchestrator — pulls through the download worker", () => {
  let stateDir: string;
  let previousFetch: typeof fetch;
  let actions: EmittedAction[];
  let worker: ReturnType<typeof inProcessWorker>;
  let orchestrator: LocalModelsOrchestrator;
  let startDaemon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-orch-dl-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    previousFetch = globalThis.fetch;
    actions = [];
    worker = inProcessWorker();
    orchestrator = new LocalModelsOrchestrator(
      {
        emit(action: unknown) {
          actions.push(action as EmittedAction);
        },
        subscribe: () => () => {},
      },
      {
        spawnDownload: worker.spawnDownload,
        stopDownload: worker.stopDownload,
        downloadPollMs: 5,
      },
    );
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();
    startDaemon = vi.spyOn(orchestrator, "startDaemon").mockResolvedValue(true) as never;
    vi.spyOn(orchestrator, "startEmbeddingPairing").mockResolvedValue();
    stubBackendInstalled(getConfig().paths.localModelsDataDir);
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("lands a model: worker record → pull events → active + daemon, record removed", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(bodyOf(["gg", "uf"]), {
        status: 200,
        headers: { "content-length": "4" },
      }),
    ) as typeof fetch;

    await orchestrator.pullModel("qwen-3.5-4b", "gguf-only");

    expect(worker.spawned).toEqual(["chat-qwen-3.5-4b"]);
    expect(startedPulls(actions)).toEqual(["qwen-3.5-4b"]);
    expect(actions.some((a) => a.type === "local_models_pull_finished")).toBe(true);
    expect(actions.filter((a) => a.type === "local_models_pull_failed")).toHaveLength(0);
    expect(startDaemon).toHaveBeenCalledOnce();
    const dataDir = getConfig().paths.localModelsDataDir;
    const def = getLocalModelDef("qwen-3.5-4b");
    expect(existsSync(resolveModelFilePath(dataDir, def.id, def.filename))).toBe(true);
    expect(getConfig().localModels.managed.modelId).toBe("qwen-3.5-4b");
    expect(readDownloadJob(dataDir, "chat-qwen-3.5-4b")).toBeNull();
  });

  it("pulls a vision model's GGUF and mmproj as one job with a summed record", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(bodyOf(["zz"]), { status: 200, headers: { "content-length": "2" } }),
    ) as typeof fetch;

    // qwen-3.5-9b is vision-capable in the current catalog.
    await orchestrator.pullModel("qwen-3.5-9b");

    const started = actions.filter(
      (a): a is Extract<EmittedAction, { type: "local_models_pull_started" }> =>
        a.type === "local_models_pull_started",
    );
    // Both files download together under one label; the bar is drawn
    // from their summed bytes rather than restarting for the projector.
    expect(started.map((a) => a.pull.label)).toEqual(["Qwen 3.5 9B GGUF (gguf + mmproj)"]);
    expect(actions.filter((a) => a.type === "local_models_pull_finished")).toHaveLength(1);
    const dataDir = getConfig().paths.localModelsDataDir;
    const def = getLocalModelDef("qwen-3.5-9b");
    expect(existsSync(resolveModelFilePath(dataDir, def.id, def.filename))).toBe(true);
    expect(
      existsSync(resolveMmprojFilePath(dataDir, def.id, def.mmprojFilename ?? "")),
    ).toBe(true);
  });

  it("a second pull detaches the watch; the first worker keeps going and its file still lands", async () => {
    const gate = gatedBody();
    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(gate.body, { status: 200, headers: { "content-length": "2" } });
      }
      return new Response(bodyOf(["zz"]), { status: 200, headers: { "content-length": "2" } });
    }) as typeof fetch;

    const first = orchestrator.pullModel("qwen-3.5-4b", "gguf-only");
    await waitFor(() => startedPulls(actions).length === 1);
    const second = orchestrator.pullModel("qwen-3.5-9b", "gguf-only");
    await waitFor(() => startedPulls(actions).length === 2);
    gate.release();
    await Promise.all([first, second]);

    const dataDir = getConfig().paths.localModelsDataDir;
    const firstDef = getLocalModelDef("qwen-3.5-4b");
    const firstPath = resolveModelFilePath(dataDir, firstDef.id, firstDef.filename);
    await waitFor(() => existsSync(firstPath));
    // Nothing was thrown away — but only the watched pull landed
    // (activated + daemon); the detached one is left for adoption.
    expect(actions.filter((a) => a.type === "local_models_pull_failed")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "local_models_pull_finished")).toHaveLength(1);
    expect(getConfig().localModels.managed.modelId).toBe("qwen-3.5-9b");
    await waitFor(() => readDownloadJob(dataDir, "chat-qwen-3.5-4b")?.status === "done");
  });

  it("keeps chat and embedding downloads running independently", async () => {
    const gate = gatedBody();
    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(gate.body, { status: 200, headers: { "content-length": "2" } });
      }
      return new Response(bodyOf(["ee"]), { status: 200, headers: { "content-length": "2" } });
    }) as typeof fetch;

    const chat = orchestrator.pullModel("qwen-3.5-4b", "gguf-only");
    await waitFor(() => startedPulls(actions).length === 1);
    const embedding = orchestrator.pullEmbeddingModel("nomic-embed-text-v1.5");
    await waitFor(() => startedPulls(actions).length === 2);
    gate.release();
    await Promise.all([chat, embedding]);

    expect(startedPulls(actions)).toEqual(["qwen-3.5-4b", "nomic-embed-text-v1.5"]);
    expect(actions.filter((a) => a.type === "local_models_pull_finished")).toHaveLength(2);
    const dataDir = getConfig().paths.localModelsDataDir;
    const emb = getEmbeddingModelDef("nomic-embed-text-v1.5");
    expect(existsSync(resolveModelFilePath(dataDir, emb.id, emb.filename))).toBe(true);
    expect(getConfig().localModels.embeddings.modelId).toBe("nomic-embed-text-v1.5");
  });

  it("cancelPull stops the worker, keeps the partial and says how to resume", async () => {
    const gate = gatedBody();
    globalThis.fetch = vi.fn(async () =>
      new Response(gate.body, { status: 200, headers: { "content-length": "2" } }),
    ) as typeof fetch;

    const pull = orchestrator.pullModel("qwen-3.5-4b", "gguf-only");
    await waitFor(() => startedPulls(actions).length === 1);
    const dataDir = getConfig().paths.localModelsDataDir;
    const def = getLocalModelDef("qwen-3.5-4b");
    const dest = resolveModelFilePath(dataDir, def.id, def.filename);
    await waitFor(() => existsSync(resolvePartialPath(dest)));

    await orchestrator.cancelPull("chat");
    gate.release();
    await pull;

    const failed = actions.find(
      (a): a is Extract<EmittedAction, { type: "local_models_pull_failed" }> =>
        a.type === "local_models_pull_failed",
    );
    expect(failed?.error).toMatch(/cancelled at \d+%.*Enter resumes/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(resolvePartialPath(dest))).toBe(true);
    expect(startDaemon).not.toHaveBeenCalled();
    expect(readDownloadJob(dataDir, "chat-qwen-3.5-4b")?.status).toBe("cancelled");
  });

  it("reports a worker failure with its own message", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 404, statusText: "Not Found" }),
    ) as typeof fetch;
    await orchestrator.pullModel("qwen-3.5-4b", "gguf-only");
    const failed = actions.find(
      (a): a is Extract<EmittedAction, { type: "local_models_pull_failed" }> =>
        a.type === "local_models_pull_failed",
    );
    expect(failed?.error).toMatch(/HTTP 404/);
  });

  describe("adoptBackgroundDownloads", () => {
    it("lands a job that finished while no TUI was watching, without spawning", async () => {
      const dataDir = getConfig().paths.localModelsDataDir;
      const def = getLocalModelDef("qwen-3.5-4b");
      const dest = resolveModelFilePath(dataDir, def.id, def.filename);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, "gguf");
      writeDownloadJob(dataDir, {
        ...initialDownloadJob({ dataDir, kind: "chat", modelId: def.id, mode: "gguf-only", pid: 1 }),
        status: "done",
        percent: 100,
        finishedAt: "2026-09-07T12:00:00.000Z",
      });

      orchestrator.adoptBackgroundDownloads();
      await waitFor(() => startDaemon.mock.calls.length === 1);

      expect(worker.spawned).toEqual([]);
      expect(getConfig().localModels.managed.modelId).toBe("qwen-3.5-4b");
      expect(infoLines(actions).some((l) => /finished downloading while the app was closed/.test(l))).toBe(true);
      await waitFor(() => readDownloadJob(dataDir, "chat-qwen-3.5-4b") === null);
    });

    it("resumes an interrupted job from its partial", async () => {
      const dataDir = getConfig().paths.localModelsDataDir;
      const def = getLocalModelDef("qwen-3.5-4b");
      const dest = resolveModelFilePath(dataDir, def.id, def.filename);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(resolvePartialPath(dest), "gg");
      writeFileSync(
        resolvePartialMetaPath(dest),
        JSON.stringify({ url: def.huggingFaceUrl, total: 4, etag: '"v1"', lastModified: null }),
      );
      writeDownloadJob(dataDir, {
        ...initialDownloadJob({ dataDir, kind: "chat", modelId: def.id, mode: "gguf-only", pid: 2_000_000_000 }),
        status: "interrupted",
      });
      globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("range")).toBe("bytes=2-");
        return new Response(bodyOf(["uf"]), {
          status: 206,
          headers: { "content-range": "bytes 2-3/4", etag: '"v1"' },
        });
      }) as typeof fetch;

      orchestrator.adoptBackgroundDownloads();
      await waitFor(() => startDaemon.mock.calls.length === 1);

      expect(worker.spawned).toEqual(["chat-qwen-3.5-4b"]);
      expect(infoLines(actions).some((l) => /interrupted at 50% — resuming/.test(l))).toBe(true);
      // The first pull_started already shows the partial, not 0%.
      const first = actions.find(
        (a): a is Extract<EmittedAction, { type: "local_models_pull_started" }> =>
          a.type === "local_models_pull_started",
      );
      expect(first?.pull.percent).toBe(50);
      expect(existsSync(dest)).toBe(true);
    });

    it("watches a worker another process is running and lands it when it ends", async () => {
      const dataDir = getConfig().paths.localModelsDataDir;
      const def = getEmbeddingModelDef("nomic-embed-text-v1.5");
      const dest = resolveModelFilePath(dataDir, def.id, def.filename);
      const record = initialDownloadJob({
        dataDir,
        kind: "embedding",
        modelId: def.id,
        mode: "gguf-only",
        pid: process.pid,
      });
      writeDownloadJob(dataDir, { ...record, percent: 30, transferredBytes: 3, totalBytes: 10 });

      orchestrator.adoptBackgroundDownloads();
      await waitFor(() => startedPulls(actions).length === 1);
      expect(worker.spawned).toEqual([]);

      // The other process finishes: file on disk, record done.
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, "embedding");
      writeDownloadJob(dataDir, {
        ...record,
        status: "done",
        percent: 100,
        transferredBytes: 10,
        totalBytes: 10,
        finishedAt: "2026-09-07T12:00:00.000Z",
      });
      await waitFor(() => actions.some((a) => a.type === "local_models_pull_finished"));
      expect(getConfig().localModels.embeddings.modelId).toBe("nomic-embed-text-v1.5");
    });

    it("leaves cancelled and failed jobs alone", () => {
      const dataDir = getConfig().paths.localModelsDataDir;
      for (const status of ["cancelled", "failed"] as const) {
        writeDownloadJob(dataDir, {
          ...initialDownloadJob({
            dataDir,
            kind: "chat",
            modelId: status === "cancelled" ? "qwen-3.5-4b" : "qwen-3.5-9b",
            mode: "gguf-only",
            pid: 1,
          }),
          status,
          error: status === "failed" ? "boom" : null,
        });
      }
      orchestrator.adoptBackgroundDownloads();
      expect(worker.spawned).toEqual([]);
      expect(startedPulls(actions)).toEqual([]);
    });
  });
});

function startedPulls(actions: readonly EmittedAction[]): string[] {
  return actions
    .filter(
      (action): action is Extract<EmittedAction, { type: "local_models_pull_started" }> =>
        action.type === "local_models_pull_started",
    )
    .map((action) => action.pull.modelId);
}

function infoLines(actions: readonly EmittedAction[]): string[] {
  return actions
    .filter(
      (action): action is Extract<EmittedAction, { type: "runtime_info" }> =>
        action.type === "runtime_info",
    )
    .map((action) => action.line);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}
