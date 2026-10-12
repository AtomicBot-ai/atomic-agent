import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addCustomModel,
  getConfig,
  resetConfigCache,
} from "../../config/index.js";
import {
  buildLocalGgufModelDef,
  listLocalModels,
  MANAGED_GGUF_PATH_ERROR,
  resolveBackendDir,
  resolveModelsDir,
  resolveServerBinPath,
  setCustomLocalModels,
  type SpawnDownloadWorkerInput,
  type SpawnDownloadWorkerResult,
} from "../../local-llm/index.js";
import { resolvePlatformAsset } from "../../local-llm/backend/platform-assets.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

/**
 * A GGUF added from disk (issue #631) at the orchestrator seam: the
 * pull never reaches the download worker, a vanished file is reported
 * where a failed pull is, and a typed path supersedes a Hugging Face
 * lookup still in flight.
 */

type Emitted = { type: string; error?: string; line?: string };

function stubBackendInstalled(dataDir: string): void {
  mkdirSync(resolveBackendDir(dataDir), { recursive: true });
  const { binaryName } = resolvePlatformAsset();
  writeFileSync(resolveServerBinPath(dataDir, binaryName), "");
}

describe("LocalModelsOrchestrator — a GGUF added from disk", () => {
  let stateDir: string;
  let userDir: string;
  let previousFetch: typeof fetch;
  let actions: Emitted[];
  let spawned: SpawnDownloadWorkerInput[];
  let orchestrator: LocalModelsOrchestrator;
  let startDaemon: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-orch-gguf-"));
    userDir = mkdtempSync(join(tmpdir(), "local-models-orch-gguf-user-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    previousFetch = globalThis.fetch;
    fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    actions = [];
    spawned = [];
    orchestrator = new LocalModelsOrchestrator(
      {
        emit(action: unknown) {
          actions.push(action as Emitted);
        },
        subscribe: () => () => {},
      },
      {
        spawnDownload: (input): SpawnDownloadWorkerResult => {
          spawned.push(input);
          throw new Error("a model added from disk must never spawn a download");
        },
        stopDownload: async (_dataDir, job) => ({ outcome: "stopped", job }),
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
    setCustomLocalModels([]);
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  function writeGguf(name = "model.gguf"): string {
    const path = join(userDir, name);
    writeFileSync(path, Buffer.alloc(128, 1));
    return path;
  }

  it("a vanished file fails the pull with its path and never spawns a download", async () => {
    const path = writeGguf();
    const def = buildLocalGgufModelDef({ path, sizeBytes: 128 });
    addCustomModel(def);
    rmSync(path);

    await orchestrator.pullModel(def.id);

    expect(spawned).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
    const failed = actions.filter((a) => a.type === "local_models_pull_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toContain(`local file is missing at ${path}`);
    expect(actions.some((a) => a.type === "local_models_pull_started")).toBe(
      false,
    );
  });

  it("a typed path registers the file in place and starts it without a download", async () => {
    const path = writeGguf();

    await orchestrator.resolveHuggingFaceReference(path);

    expect(spawned).toEqual([]);
    // Only the local daemon's own health probe may go out: nothing is
    // looked up on, or fetched from, anywhere else.
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.filter((u) => !u.startsWith("http://127.0.0.1:"))).toEqual(
      [],
    );
    expect(actions.some((a) => a.type === "local_models_hf_closed")).toBe(true);
    expect(
      actions.filter((a) => a.type === "local_models_pull_failed"),
    ).toHaveLength(0);
    expect(startDaemon).toHaveBeenCalledOnce();
    expect(
      listLocalModels()
        .filter((m) => m.family === "custom")
        .map((m) => m.localPath),
    ).toEqual([path]);
  });

  it("refuses a path inside the managed models directory, in words", async () => {
    const managed = resolveModelsDir(getConfig().paths.localModelsDataDir);
    mkdirSync(join(managed, "qwen-3.5-4b"), { recursive: true });
    const path = join(managed, "qwen-3.5-4b", "model.gguf");
    writeFileSync(path, "x");

    await orchestrator.resolveHuggingFaceReference(path);

    const failed = actions.filter(
      (a) => a.type === "local_models_hf_lookup_failed",
    );
    expect(failed.map((a) => a.error)).toEqual([MANAGED_GGUF_PATH_ERROR]);
    expect(listLocalModels().filter((m) => m.family === "custom")).toEqual(
      [],
    );
    expect(startDaemon).not.toHaveBeenCalled();
  });

  it("a typed path aborts a Hugging Face lookup still in flight", async () => {
    let lookupSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      async (input: unknown, init?: { signal?: AbortSignal }) => {
        // The local daemon's health probe answers at once; only the
        // Hugging Face lookup hangs until it is aborted.
        if (String(input).startsWith("http://127.0.0.1:")) {
          return new Response(null, { status: 500 });
        }
        return new Promise<Response>((_resolve, reject) => {
          lookupSignal = init?.signal ?? undefined;
          lookupSignal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      },
    );
    const lookup = orchestrator.resolveHuggingFaceReference(
      "unsloth/Qwen3.5-4B-GGUF",
    );
    await vi.waitFor(() => expect(lookupSignal).toBeDefined());

    await orchestrator.resolveHuggingFaceReference(writeGguf());
    await lookup;

    expect(lookupSignal?.aborted).toBe(true);
    // The late answer of the dropped lookup lands nowhere.
    expect(
      actions.filter(
        (a) =>
          a.type === "local_models_hf_lookup_failed" ||
          a.type === "local_models_hf_repo_resolved",
      ),
    ).toHaveLength(0);
    expect(startDaemon).toHaveBeenCalledOnce();
  });
});
