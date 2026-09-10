import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureUserConfigFileSync,
  getConfig,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../../config/index.js";
import {
  downloadJobId,
  readDownloadNotify,
  writeDownloadNotify,
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
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
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
  | {
      type: "local_models_pull_progress";
      waiting?: { attempt: number; reason: string } | null;
    }
  | {
      type: "local_models_notify_prompt_opened";
      prompt: { label: string; current: string | null };
    }
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

/** Serves the weights, answers 404 for the projector — a repo that renamed its mmproj. */
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

/** Records written by the fake worker, plus a way to abort one. */
function inProcessWorker(): {
  spawnDownload: (input: SpawnDownloadWorkerInput) => SpawnDownloadWorkerResult;
  stopDownload: (
    dataDir: string,
    job: DownloadJob,
  ) => Promise<StopDownloadWorkerResult>;
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
        heartbeatMs: 0,
        retryDelayMs: 20,
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
        staleGraceMs: 10,
      },
    );
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();
    startDaemon = vi
      .spyOn(orchestrator, "startDaemon")
      .mockResolvedValue(true) as never;
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
    globalThis.fetch = vi.fn(
      async () =>
        new Response(bodyOf(["gg", "uf"]), {
          status: 200,
          headers: { "content-length": "4" },
        }),
    ) as typeof fetch;

    await orchestrator.pullModel("qwen-3.5-4b", "gguf-only");

    expect(worker.spawned).toEqual(["chat-qwen-3.5-4b"]);
    expect(startedPulls(actions)).toEqual(["qwen-3.5-4b"]);
    expect(actions.some((a) => a.type === "local_models_pull_finished")).toBe(
      true,
    );
    expect(
      actions.filter((a) => a.type === "local_models_pull_failed"),
    ).toHaveLength(0);
    expect(startDaemon).toHaveBeenCalledOnce();
    const dataDir = getConfig().paths.localModelsDataDir;
    const def = getLocalModelDef("qwen-3.5-4b");
    expect(
      existsSync(resolveModelFilePath(dataDir, def.id, def.filename)),
    ).toBe(true);
    expect(getConfig().localModels.managed.modelId).toBe("qwen-3.5-4b");
    expect(readDownloadJob(dataDir, "chat-qwen-3.5-4b")).toBeNull();
  });

  it("pulls a vision model's GGUF and mmproj as one job with a summed record", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(bodyOf(["zz"]), {
          status: 200,
          headers: { "content-length": "2" },
        }),
    ) as typeof fetch;

    // qwen-3.5-9b is vision-capable in the current catalog.
    await orchestrator.pullModel("qwen-3.5-9b");

    const started = actions.filter(
      (a): a is Extract<EmittedAction, { type: "local_models_pull_started" }> =>
        a.type === "local_models_pull_started",
    );
    // Both files download together under one label; the bar is drawn
    // from their summed bytes rather than restarting for the projector.
    expect(started.map((a) => a.pull.label)).toEqual([
      "Qwen 3.5 9B GGUF (gguf + mmproj)",
    ]);
    expect(
      actions.filter((a) => a.type === "local_models_pull_finished"),
    ).toHaveLength(1);
    const dataDir = getConfig().paths.localModelsDataDir;
    const def = getLocalModelDef("qwen-3.5-9b");
    expect(
      existsSync(resolveModelFilePath(dataDir, def.id, def.filename)),
    ).toBe(true);
    expect(
      existsSync(
        resolveMmprojFilePath(dataDir, def.id, def.mmprojFilename ?? ""),
      ),
    ).toBe(true);
  });

  it("a second pull detaches the watch; the first worker keeps going and its file still lands", async () => {
    const gate = gatedBody();
    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(gate.body, {
          status: 200,
          headers: { "content-length": "2" },
        });
      }
      return new Response(bodyOf(["zz"]), {
        status: 200,
        headers: { "content-length": "2" },
      });
    }) as typeof fetch;

    const first = orchestrator.pullModel("qwen-3.5-4b", "gguf-only");
    await waitFor(() => startedPulls(actions).length === 1);
    const second = orchestrator.pullModel("qwen-3.5-9b", "gguf-only");
    await waitFor(() => startedPulls(actions).length === 2);
    gate.release();
    await Promise.all([first, second]);

    const dataDir = getConfig().paths.localModelsDataDir;
    const firstDef = getLocalModelDef("qwen-3.5-4b");
    const firstPath = resolveModelFilePath(
      dataDir,
      firstDef.id,
      firstDef.filename,
    );
    await waitFor(() => existsSync(firstPath));
    // Nothing was thrown away — but only the watched pull landed
    // (activated + daemon); the detached one is left for adoption.
    expect(
      actions.filter((a) => a.type === "local_models_pull_failed"),
    ).toHaveLength(0);
    expect(
      actions.filter((a) => a.type === "local_models_pull_finished"),
    ).toHaveLength(1);
    expect(getConfig().localModels.managed.modelId).toBe("qwen-3.5-9b");
    await waitFor(
      () => readDownloadJob(dataDir, "chat-qwen-3.5-4b")?.status === "done",
    );
  });

  it("keeps chat and embedding downloads running independently", async () => {
    const gate = gatedBody();
    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(gate.body, {
          status: 200,
          headers: { "content-length": "2" },
        });
      }
      return new Response(bodyOf(["ee"]), {
        status: 200,
        headers: { "content-length": "2" },
      });
    }) as typeof fetch;

    const chat = orchestrator.pullModel("qwen-3.5-4b", "gguf-only");
    await waitFor(() => startedPulls(actions).length === 1);
    const embedding = orchestrator.pullEmbeddingModel("nomic-embed-text-v1.5");
    await waitFor(() => startedPulls(actions).length === 2);
    gate.release();
    await Promise.all([chat, embedding]);

    expect(startedPulls(actions)).toEqual([
      "qwen-3.5-4b",
      "nomic-embed-text-v1.5",
    ]);
    expect(
      actions.filter((a) => a.type === "local_models_pull_finished"),
    ).toHaveLength(2);
    const dataDir = getConfig().paths.localModelsDataDir;
    const emb = getEmbeddingModelDef("nomic-embed-text-v1.5");
    expect(
      existsSync(resolveModelFilePath(dataDir, emb.id, emb.filename)),
    ).toBe(true);
    expect(getConfig().localModels.embeddings.modelId).toBe(
      "nomic-embed-text-v1.5",
    );
  });

  it("cancelPull stops the worker, keeps the partial and says how to resume", async () => {
    const gate = gatedBody();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(gate.body, {
          status: 200,
          headers: { "content-length": "2" },
        }),
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
    expect(readDownloadJob(dataDir, "chat-qwen-3.5-4b")?.status).toBe(
      "cancelled",
    );
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

  it("lands a vision model text-only when its projector fails after the GGUF", async () => {
    globalThis.fetch = fetchWithMissingProjector();

    await orchestrator.pullModel("qwen-3.5-4b", "with-mmproj");

    expect(
      actions.filter((a) => a.type === "local_models_pull_failed"),
    ).toHaveLength(0);
    expect(actions.some((a) => a.type === "local_models_pull_finished")).toBe(
      true,
    );
    expect(startDaemon).toHaveBeenCalledOnce();
    expect(getConfig().localModels.managed.modelId).toBe("qwen-3.5-4b");
    expect(
      infoLines(actions).some((l) =>
        /projector not downloaded \(.*HTTP 404.*\).*text-only/.test(l),
      ),
    ).toBe(true);
    const dataDir = getConfig().paths.localModelsDataDir;
    const def = getLocalModelDef("qwen-3.5-4b");
    expect(
      existsSync(resolveModelFilePath(dataDir, def.id, def.filename)),
    ).toBe(true);
    expect(readDownloadJob(dataDir, "chat-qwen-3.5-4b")).toBeNull();
  });

  it("a failed projector-only pull reports where a failed pull reports and touches nothing else", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    const def = getLocalModelDef("qwen-3.5-4b");
    const dest = resolveModelFilePath(dataDir, def.id, def.filename);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, "gguf");
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { modelId: "qwen-3.5-9b" },
    });
    resetConfigCache();
    globalThis.fetch = fetchWithMissingProjector();

    await orchestrator.pullModel("qwen-3.5-4b", "mmproj-only");

    // The pane's failure line is where the operator looked before; the
    // wording now says the model is fine and how to retry.
    const failed = actions.find(
      (a): a is Extract<EmittedAction, { type: "local_models_pull_failed" }> =>
        a.type === "local_models_pull_failed",
    );
    expect(failed?.error).toMatch(
      /projector not downloaded \(.*HTTP 404.*\).*works text-only.*retries the projector/,
    );
    // A projector-only pull never picks the active model or starts a
    // daemon — success does not, so failure must not either.
    expect(startDaemon).not.toHaveBeenCalled();
    expect(getConfig().localModels.managed.modelId).toBe("qwen-3.5-9b");
    expect(readDownloadJob(dataDir, "chat-qwen-3.5-4b")).toBeNull();
  });

  describe("adoptBackgroundDownloads", () => {
    it("lands a job that finished while no TUI was watching, without spawning", async () => {
      const dataDir = getConfig().paths.localModelsDataDir;
      const def = getLocalModelDef("qwen-3.5-4b");
      const dest = resolveModelFilePath(dataDir, def.id, def.filename);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, "gguf");
      writeDownloadJob(dataDir, {
        ...initialDownloadJob({
          dataDir,
          kind: "chat",
          modelId: def.id,
          mode: "gguf-only",
          pid: 1,
        }),
        status: "done",
        percent: 100,
        finishedAt: "2026-09-07T12:00:00.000Z",
      });

      orchestrator.adoptBackgroundDownloads();
      await waitFor(() => startDaemon.mock.calls.length === 1);

      expect(worker.spawned).toEqual([]);
      expect(getConfig().localModels.managed.modelId).toBe("qwen-3.5-4b");
      expect(
        infoLines(actions).some((l) =>
          /finished downloading while the app was closed/.test(l),
        ),
      ).toBe(true);
      await waitFor(
        () => readDownloadJob(dataDir, "chat-qwen-3.5-4b") === null,
      );
    });

    it("lands a text-only job that finished while the app was closed, without re-fetching the projector", async () => {
      const dataDir = getConfig().paths.localModelsDataDir;
      const def = getLocalModelDef("qwen-3.5-4b");
      const dest = resolveModelFilePath(dataDir, def.id, def.filename);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, "gguf");
      writeDownloadJob(dataDir, {
        ...initialDownloadJob({
          dataDir,
          kind: "chat",
          modelId: def.id,
          mode: "with-mmproj",
          pid: 1,
        }),
        status: "done",
        finishedAt: "2026-09-07T12:00:00.000Z",
        mmprojError: "Download failed: HTTP 404 Not Found",
      });
      globalThis.fetch = vi.fn(async () => {
        throw new Error("no network call expected at launch");
      }) as typeof fetch;

      orchestrator.adoptBackgroundDownloads();
      await waitFor(() => startDaemon.mock.calls.length === 1);

      expect(worker.spawned).toEqual([]);
      expect(getConfig().localModels.managed.modelId).toBe("qwen-3.5-4b");
      expect(
        infoLines(actions).some((l) =>
          /projector not downloaded \(.*HTTP 404/.test(l),
        ),
      ).toBe(true);
      await waitFor(
        () => readDownloadJob(dataDir, "chat-qwen-3.5-4b") === null,
      );
    });

    it("a projector-only job that failed while the app was closed is reported, not re-run, and never switches the model", async () => {
      const dataDir = getConfig().paths.localModelsDataDir;
      const def = getLocalModelDef("qwen-3.5-4b");
      const dest = resolveModelFilePath(dataDir, def.id, def.filename);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, "gguf");
      persistUserLocalModelsConfig({
        mode: "managed",
        managed: { modelId: "qwen-3.5-9b" },
      });
      resetConfigCache();
      writeDownloadJob(dataDir, {
        ...initialDownloadJob({
          dataDir,
          kind: "chat",
          modelId: def.id,
          mode: "mmproj-only",
          pid: 1,
        }),
        status: "done",
        finishedAt: "2026-09-07T12:00:00.000Z",
        mmprojError: "Download failed: HTTP 404 Not Found",
      });
      globalThis.fetch = vi.fn(async () => {
        throw new Error("no network call expected at launch");
      }) as typeof fetch;

      orchestrator.adoptBackgroundDownloads();
      await waitFor(
        () => readDownloadJob(dataDir, "chat-qwen-3.5-4b") === null,
      );

      expect(worker.spawned).toEqual([]);
      expect(startDaemon).not.toHaveBeenCalled();
      expect(getConfig().localModels.managed.modelId).toBe("qwen-3.5-9b");
      expect(
        infoLines(actions).some((l) =>
          /projector not downloaded \(.*HTTP 404/.test(l),
        ),
      ).toBe(true);
    });

    it("leaves another running chat job alone while a chat pull is being watched", async () => {
      // Enter on a vision row makes it live AND fetches its projector; the
      // activation's refresh must not re-adopt an unrelated running
      // download and detach the projector watch (the two would then
      // detach each other on every refresh, and whichever landed first
      // would switch the model).
      const dataDir = getConfig().paths.localModelsDataDir;
      const def = getLocalModelDef("qwen-3.5-4b");
      const dest = resolveModelFilePath(dataDir, def.id, def.filename);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, "gguf");
      const gate = gatedBody();
      globalThis.fetch = vi.fn(
        async () =>
          new Response(gate.body, {
            status: 200,
            headers: { "content-length": "2" },
          }),
      ) as typeof fetch;
      const pull = orchestrator.pullModel("qwen-3.5-4b", "mmproj-only");
      await waitFor(() => startedPulls(actions).includes("qwen-3.5-4b"));
      // Another chat model is downloading in a live worker of its own.
      writeDownloadJob(dataDir, {
        ...initialDownloadJob({
          dataDir,
          kind: "chat",
          modelId: "qwen-3.5-9b",
          mode: "gguf-only",
          pid: process.pid,
        }),
      });

      orchestrator.adoptBackgroundDownloads({ onlyRunning: true });
      gate.release();
      await pull;

      expect(worker.spawned).toEqual(["chat-qwen-3.5-4b"]);
      expect(actions.some((a) => a.type === "local_models_pull_finished")).toBe(
        true,
      );
      expect(infoLines(actions).some((l) => /mmproj installed/.test(l))).toBe(
        true,
      );
    });

    it("resumes an interrupted job from its partial", async () => {
      const dataDir = getConfig().paths.localModelsDataDir;
      const def = getLocalModelDef("qwen-3.5-4b");
      const dest = resolveModelFilePath(dataDir, def.id, def.filename);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(resolvePartialPath(dest), "gg");
      writeFileSync(
        resolvePartialMetaPath(dest),
        JSON.stringify({
          url: def.huggingFaceUrl,
          total: 4,
          etag: '"v1"',
          lastModified: null,
        }),
      );
      writeDownloadJob(dataDir, {
        ...initialDownloadJob({
          dataDir,
          kind: "chat",
          modelId: def.id,
          mode: "gguf-only",
          pid: 2_000_000_000,
        }),
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
      expect(
        infoLines(actions).some((l) => /interrupted at 50% — resuming/.test(l)),
      ).toBe(true);
      // The first pull_started already shows the partial, not 0%.
      const first = actions.find(
        (
          a,
        ): a is Extract<EmittedAction, { type: "local_models_pull_started" }> =>
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
      writeDownloadJob(dataDir, {
        ...record,
        percent: 30,
        transferredBytes: 3,
        totalBytes: 10,
      });

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
      await waitFor(() =>
        actions.some((a) => a.type === "local_models_pull_finished"),
      );
      expect(getConfig().localModels.embeddings.modelId).toBe(
        "nomic-embed-text-v1.5",
      );
    });

    it("leaves cancelled and non-resumable failed jobs alone", () => {
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
          error:
            status === "failed" ? "Download failed: HTTP 404 Not Found" : null,
          resumable: false,
        });
      }
      orchestrator.adoptBackgroundDownloads();
      expect(worker.spawned).toEqual([]);
      expect(startedPulls(actions)).toEqual([]);
    });

    it("resumes a job that gave up on an outage, from its partial", async () => {
      // What a laptop that was offline for a week — or a 0.5.6 worker
      // that ran out of retries — leaves behind: `failed`, partial intact.
      const dataDir = getConfig().paths.localModelsDataDir;
      const def = getLocalModelDef("qwen-3.5-4b");
      const dest = resolveModelFilePath(dataDir, def.id, def.filename);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(resolvePartialPath(dest), "gg");
      writeFileSync(
        resolvePartialMetaPath(dest),
        JSON.stringify({
          url: def.huggingFaceUrl,
          total: 4,
          etag: '"v1"',
          lastModified: null,
        }),
      );
      writeDownloadJob(dataDir, {
        ...initialDownloadJob({
          dataDir,
          kind: "chat",
          modelId: def.id,
          mode: "gguf-only",
          pid: 2_000_000_000,
        }),
        status: "failed",
        error:
          "Download gave up: no progress for 7 days (last error: fetch failed)",
        resumable: true,
        finishedAt: "2026-09-07T12:00:00.000Z",
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
      expect(
        infoLines(actions).some((l) => /gave up at 50%.*— resuming/.test(l)),
      ).toBe(true);
      expect(existsSync(dest)).toBe(true);
    });

    it("declares a silent worker dead after the grace period and relaunches it", async () => {
      // A `running` record whose pid answers (it is ours) but that
      // nobody has written for ten minutes — a recycled pid after a
      // reboot looks exactly like this.
      const dataDir = getConfig().paths.localModelsDataDir;
      const def = getLocalModelDef("qwen-3.5-4b");
      const dest = resolveModelFilePath(dataDir, def.id, def.filename);
      const stale = new Date(Date.now() - 10 * 60_000).toISOString();
      writeDownloadJob(dataDir, {
        ...initialDownloadJob({
          dataDir,
          kind: "chat",
          modelId: def.id,
          mode: "gguf-only",
          pid: process.pid,
        }),
        percent: 30,
        transferredBytes: 3,
        totalBytes: 10,
        startedAt: stale,
        updatedAt: stale,
      });
      globalThis.fetch = vi.fn(
        async () =>
          new Response(bodyOf(["gguf"]), {
            status: 200,
            headers: { "content-length": "4" },
          }),
      ) as typeof fetch;

      orchestrator.adoptBackgroundDownloads();
      await waitFor(() => startDaemon.mock.calls.length === 1);

      expect(worker.spawned).toEqual(["chat-qwen-3.5-4b"]);
      expect(
        infoLines(actions).some((l) =>
          /stopped reporting at 30% — relaunching/.test(l),
        ),
      ).toBe(true);
      expect(existsSync(dest)).toBe(true);
    });

    it("stops a silent worker that is still ours before relaunching onto its partial", async () => {
      const dataDir = getConfig().paths.localModelsDataDir;
      const def = getLocalModelDef("qwen-3.5-4b");
      const dest = resolveModelFilePath(dataDir, def.id, def.filename);
      const stale = new Date(Date.now() - 10 * 60_000).toISOString();
      writeDownloadJob(dataDir, {
        ...initialDownloadJob({
          dataDir,
          kind: "chat",
          modelId: def.id,
          mode: "gguf-only",
          pid: process.pid,
        }),
        startedAt: stale,
        updatedAt: stale,
      });
      globalThis.fetch = vi.fn(
        async () =>
          new Response(bodyOf(["gguf"]), {
            status: 200,
            headers: { "content-length": "4" },
          }),
      ) as typeof fetch;
      const stops: number[] = [];
      const ours = new LocalModelsOrchestrator(
        {
          emit: (a: unknown) => actions.push(a as EmittedAction),
          subscribe: () => () => {},
        },
        {
          spawnDownload: worker.spawnDownload,
          stopDownload: async (d, job) => {
            stops.push(job.pid);
            return worker.stopDownload(d, job);
          },
          downloadPollMs: 5,
          staleGraceMs: 10,
          isDownloadWorkerPid: () => true,
        },
      );
      vi.spyOn(ours, "refresh").mockResolvedValue();
      const start = vi.spyOn(ours, "startDaemon").mockResolvedValue(true);
      vi.spyOn(ours, "startEmbeddingPairing").mockResolvedValue();

      ours.adoptBackgroundDownloads();
      await waitFor(() => start.mock.calls.length === 1);

      // The old pid was asked to stop before the record was rewritten.
      expect(stops).toEqual([process.pid]);
      expect(worker.spawned).toEqual(["chat-qwen-3.5-4b"]);
      expect(existsSync(dest)).toBe(true);
      await ours.shutdown();
    });

    it("mirrors the worker's wait for the network onto the pull state", async () => {
      const dataDir = getConfig().paths.localModelsDataDir;
      const def = getLocalModelDef("qwen-3.5-4b");
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("ENETDOWN"), { code: "ENETDOWN" }),
          });
        }
        return new Response(bodyOf(["gguf"]), {
          status: 200,
          headers: { "content-length": "4" },
        });
      }) as typeof fetch;

      void orchestrator.pullModel(def.id, "gguf-only");
      await waitFor(() => startDaemon.mock.calls.length === 1);

      const waits = actions.filter(
        (
          a,
        ): a is Extract<
          EmittedAction,
          { type: "local_models_pull_progress" }
        > => a.type === "local_models_pull_progress" && !!a.waiting,
      );
      expect(waits.length).toBeGreaterThan(0);
      expect(waits[0].waiting).toMatchObject({
        attempt: 1,
        reason: "fetch failed",
      });
      // The last progress report before landing has the wait cleared.
      const last = actions
        .filter(
          (
            a,
          ): a is Extract<
            EmittedAction,
            { type: "local_models_pull_progress" }
          > => a.type === "local_models_pull_progress",
        )
        .at(-1);
      expect(last?.waiting).toBeNull();
    });
  });
});

describe("LocalModelsOrchestrator — tell me when it lands", () => {
  let stateDir: string;
  let previousFetch: typeof fetch;
  let actions: EmittedAction[];
  let worker: ReturnType<typeof inProcessWorker>;
  let orchestrator: LocalModelsOrchestrator;
  let opened: Array<{ id: string; message: string }>;
  let startDaemon: ReturnType<typeof vi.fn>;

  function pairTelegram(): void {
    const path = getConfig().paths.userConfigFile;
    const prev = ensureUserConfigFileSync(path);
    writeUserConfigFileSync(path, {
      ...prev,
      telegram: { ...prev.telegram, ownerUserId: 4242 },
    });
    resetConfigCache();
    process.env.TELEGRAM_BOT_TOKEN =
      "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-notify-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    delete process.env.TELEGRAM_BOT_TOKEN;
    resetConfigCache();
    stubBackendInstalled(getConfig().paths.localModelsDataDir);
    previousFetch = globalThis.fetch;
    actions = [];
    opened = [];
    worker = inProcessWorker();
    orchestrator = new LocalModelsOrchestrator(
      {
        emit: (a: unknown) => actions.push(a as EmittedAction),
        subscribe: () => () => {},
      },
      {
        spawnDownload: worker.spawnDownload,
        stopDownload: worker.stopDownload,
        downloadPollMs: 5,
        openIntegration: (id, message) => opened.push({ id, message }),
      },
    );
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();
    startDaemon = vi
      .spyOn(orchestrator, "startDaemon")
      .mockResolvedValue(true) as never;
    vi.spyOn(orchestrator, "startEmbeddingPairing").mockResolvedValue();
  });

  afterEach(async () => {
    await orchestrator.shutdown();
    globalThis.fetch = previousFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** A body that never ends until released — the pull stays in flight. */
  function slowFetch(): { release: () => void } {
    const gate = gatedBody();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(gate.body, {
          status: 200,
          headers: { "content-length": "2" },
        }),
    ) as typeof fetch;
    return gate;
  }

  function prompts(): Array<{ label: string; current: string | null }> {
    return actions
      .filter(
        (
          a,
        ): a is Extract<
          EmittedAction,
          { type: "local_models_notify_prompt_opened" }
        > => a.type === "local_models_notify_prompt_opened",
      )
      .map((a) => a.prompt);
  }

  it("asks once when a pull starts and nobody has answered yet", async () => {
    const gate = slowFetch();
    void orchestrator.pullModel("qwen-3.5-4b", "gguf-only");
    await waitFor(() => prompts().length === 1);
    expect(prompts()[0]).toEqual({
      label: getLocalModelDef("qwen-3.5-4b").name,
      current: null,
    });
    gate.release();
    await waitFor(() => startDaemon.mock.calls.length === 1);
  });

  it("does not ask during onboarding, nor once an answer is remembered", async () => {
    const gate = slowFetch();
    void orchestrator.pullModel("qwen-3.5-4b", "gguf-only", {
      askNotify: false,
    });
    await waitFor(() => startedPulls(actions).length === 1);
    expect(prompts()).toEqual([]);
    gate.release();
    await waitFor(() => startDaemon.mock.calls.length === 1);

    orchestrator.chooseDownloadNotify("off");
    expect(getConfig().notifications.downloads.channel).toBe("off");
    actions.length = 0;
    const gate2 = slowFetch();
    void orchestrator.pullModel("qwen-3.5-9b", "gguf-only");
    await waitFor(() => startedPulls(actions).length === 1);
    expect(prompts()).toEqual([]);
    gate2.release();
    await waitFor(() => startDaemon.mock.calls.length === 2);
  });

  it("arms the ping on the download in flight when the channel is set up", async () => {
    pairTelegram();
    const gate = slowFetch();
    void orchestrator.pullModel("qwen-3.5-4b", "gguf-only");
    await waitFor(() => prompts().length === 1);
    orchestrator.chooseDownloadNotify("telegram");
    expect(getConfig().notifications.downloads.channel).toBe("telegram");
    expect(orchestrator.notifyArmedFor("chat")).toBe("telegram");
    expect(
      infoLines(actions).some((l) =>
        /Telegram ping armed for Qwen 3.5 4B GGUF/.test(l),
      ),
    ).toBe(true);
    expect(opened).toEqual([]);
    gate.release();
    await waitFor(() => startDaemon.mock.calls.length === 1);
  });

  it("arms the remembered channel by itself on later pulls", async () => {
    pairTelegram();
    orchestrator.chooseDownloadNotify("telegram");
    const gate = slowFetch();
    void orchestrator.pullModel("qwen-3.5-4b", "gguf-only");
    await waitFor(() => startedPulls(actions).length === 1);
    expect(prompts()).toEqual([]);
    await waitFor(() => orchestrator.notifyArmedFor("chat") === "telegram");
    gate.release();
    await waitFor(() => startDaemon.mock.calls.length === 1);
  });

  it("sends the operator to the hub when the channel has no credentials, and arms once it has", async () => {
    const gate = slowFetch();
    void orchestrator.pullModel("qwen-3.5-4b", "gguf-only");
    await waitFor(() => prompts().length === 1);
    orchestrator.chooseDownloadNotify("telegram");
    // Remembered anyway — the answer was given; only the credentials are missing.
    expect(getConfig().notifications.downloads.channel).toBe("telegram");
    expect(opened).toEqual([
      {
        id: "telegram",
        message:
          "Set up Telegram to get pinged when Qwen 3.5 4B GGUF lands — the download keeps going meanwhile.",
      },
    ]);
    expect(orchestrator.notifyArmedFor("chat")).toBeNull();

    // The hub does its job while the download runs…
    pairTelegram();
    await waitFor(() => orchestrator.notifyArmedFor("chat") === "telegram");
    expect(
      infoLines(actions).some((l) =>
        /Telegram is set up — ping armed for Qwen 3.5 4B GGUF/.test(l),
      ),
    ).toBe(true);
    gate.release();
    await waitFor(() => startDaemon.mock.calls.length === 1);
    // …and the record removal after landing takes the request with it.
    await waitFor(
      () =>
        readDownloadNotify(
          getConfig().paths.localModelsDataDir,
          downloadJobId("chat", "qwen-3.5-4b"),
        ) === null,
    );
  });

  it("keeps a ping armed from the CLI, and never asks about a job it merely adopted", async () => {
    // `models pull --background --notify discord` in another terminal:
    // the sidecar is the operator's word, whatever this TUI remembers.
    pairTelegram();
    orchestrator.chooseDownloadNotify("telegram");
    const dataDir = getConfig().paths.localModelsDataDir;
    const def = getLocalModelDef("qwen-3.5-4b");
    const dest = resolveModelFilePath(dataDir, def.id, def.filename);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(resolvePartialPath(dest), "gg");
    writeFileSync(
      resolvePartialMetaPath(dest),
      JSON.stringify({
        url: def.huggingFaceUrl,
        total: 4,
        etag: '"v1"',
        lastModified: null,
      }),
    );
    const jobId = downloadJobId("chat", def.id);
    writeDownloadJob(dataDir, {
      ...initialDownloadJob({
        dataDir,
        kind: "chat",
        modelId: def.id,
        mode: "gguf-only",
        pid: 2_000_000_000,
      }),
      status: "interrupted",
    });
    writeDownloadNotify(dataDir, jobId, "discord");
    globalThis.fetch = vi.fn(
      async () =>
        new Response(bodyOf(["uf"]), {
          status: 206,
          headers: { "content-range": "bytes 2-3/4", etag: '"v1"' },
        }),
    ) as typeof fetch;
    actions.length = 0;

    orchestrator.adoptBackgroundDownloads();
    await waitFor(() => startedPulls(actions).length === 1);
    expect(prompts()).toEqual([]);
    expect(readDownloadNotify(dataDir, jobId)).toBe("discord");
    await waitFor(() => startDaemon.mock.calls.length === 1);
  });

  it("forgets a ping that was waiting for credentials once its download is over", async () => {
    const gate = slowFetch();
    void orchestrator.pullModel("qwen-3.5-4b", "gguf-only");
    await waitFor(() => prompts().length === 1);
    orchestrator.chooseDownloadNotify("telegram");
    expect(opened).toHaveLength(1);
    gate.release();
    await waitFor(() => startDaemon.mock.calls.length === 1);
    await waitFor(() =>
      actions.some((a) => a.type === "local_models_pull_finished"),
    );

    // Credentials arrive later, with nothing in flight: no stale "armed
    // for <old model>" line, and the next pull is armed on its own merit.
    pairTelegram();
    actions.length = 0;
    const gate2 = slowFetch();
    void orchestrator.pullModel("qwen-3.5-9b", "gguf-only");
    await waitFor(() => orchestrator.notifyArmedFor("chat") === "telegram");
    expect(
      infoLines(actions).some((l) => /is set up — ping armed/.test(l)),
    ).toBe(false);
    expect(
      infoLines(actions).some((l) =>
        /Telegram ping armed for Qwen 3.5 9B/.test(l),
      ),
    ).toBe(true);
    gate2.release();
    await waitFor(() => startDaemon.mock.calls.length === 2);
  });

  it("N reopens the prompt about the download in flight, or about the next ones", async () => {
    orchestrator.openDownloadNotifyPrompt();
    expect(prompts().at(-1)).toEqual({
      label: "future downloads",
      current: null,
    });
    const gate = slowFetch();
    void orchestrator.pullModel("qwen-3.5-4b", "gguf-only");
    await waitFor(() => startedPulls(actions).length === 1);
    orchestrator.dismissDownloadNotify();
    orchestrator.openDownloadNotifyPrompt();
    expect(prompts().at(-1)).toEqual({
      label: getLocalModelDef("qwen-3.5-4b").name,
      current: null,
    });
    gate.release();
    await waitFor(() => startDaemon.mock.calls.length === 1);
  });
});

function startedPulls(actions: readonly EmittedAction[]): string[] {
  return actions
    .filter(
      (
        action,
      ): action is Extract<
        EmittedAction,
        { type: "local_models_pull_started" }
      > => action.type === "local_models_pull_started",
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
