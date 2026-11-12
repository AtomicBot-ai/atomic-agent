import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../local-llm/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../local-llm/index.js")
  >("../../local-llm/index.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(),
    reclaimManagedPort: vi.fn(async () => ({ kind: "free" })),
    fetchServedModelIds: vi.fn(async () => null),
    getEmbeddingDaemonStatus: vi.fn(),
    startEmbeddingDaemon: vi.fn(),
    stopEmbeddingDaemon: vi.fn(),
    maybeAutoUpdateBackend: vi.fn(async () => ({ action: "skipped" })),
    holdEmbeddingForLowMemory: vi.fn(async () => ({ ok: true })),
  };
});

import { getConfig, resetConfigCache } from "../../config/index.js";
import {
  getUserConfigPath,
  readUserConfigFileSync,
  writeUserConfigFileSync,
} from "../../config/config-file.js";
import * as localLlm from "../../local-llm/index.js";
import {
  getEmbeddingModelDef,
  resolveBackendDir,
  resolveModelFilePath,
  resolveServerBinPath,
} from "../../local-llm/index.js";
import { resolvePlatformAsset } from "../../local-llm/backend/platform-assets.js";
import { resetLowMemoryEmbeddingNote } from "../../local-llm/server/embedding-memory-gate.js";
import { persistMemoryEmbeddingsEnabled } from "../persist-embedding-hybrid-recall.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

type Emitted = { type: string; line?: string };
type Internals = { embeddingKeptForCloud: boolean; supervisor: { stop(): void } };

/**
 * ATO-378 / ATO-1123: on a cloud chat route the memory model runs alone.
 * At launch it starts when embeddings are on, the model is on disk and
 * the engine is installed; the runtime then attaches memory to it. No
 * chat model starts, and nothing is downloaded (ATO-357).
 */
describe("LocalModelsOrchestrator: the memory model alone on a cloud chat route", () => {
  let stateDir: string;
  let embeddingUp: boolean;
  const built: Internals[] = [];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-cloud-emb-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { engine: "llama-server", modelId: "qwen-3.5-4b" },
      embeddings: { enabled: true, modelId: "bge-m3" },
    });
    persistMemoryEmbeddingsEnabled(false);
    resetConfigCache();
    embeddingUp = false;
    vi.mocked(localLlm.getDaemonStatus).mockReset().mockResolvedValue({
      running: false, healthy: false, loading: false, pid: null, port: 19091,
    });
    vi.mocked(localLlm.getEmbeddingDaemonStatus).mockReset().mockImplementation(async () => ({
      running: embeddingUp, healthy: embeddingUp, loading: false, pid: embeddingUp ? 5678 : null, port: 19092,
    }));
    vi.mocked(localLlm.startEmbeddingDaemon).mockReset().mockImplementation(async () => {
      embeddingUp = true;
      return { pid: 5678 };
    });
    vi.mocked(localLlm.stopEmbeddingDaemon).mockReset();
    vi.mocked(localLlm.holdEmbeddingForLowMemory).mockReset().mockResolvedValue({ ok: true });
    resetLowMemoryEmbeddingNote();
  });

  afterEach(() => {
    for (const inner of built.splice(0)) inner.supervisor.stop();
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function activate(provider: "openrouter" | "local-llama"): void {
    const path = getUserConfigPath(stateDir);
    const file = readUserConfigFileSync(path);
    writeUserConfigFileSync(path, {
      ...file,
      llm: {
        activeTextProvider: provider,
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
          { id: "openrouter", kind: "openrouter", apiKey: "test", defaultChatModel: "openai/gpt-5.5" },
        ],
      },
    });
    resetConfigCache();
  }

  function build() {
    const actions: Emitted[] = [];
    const onEmbeddingModelChanged = vi.fn();
    const orchestrator = new LocalModelsOrchestrator(
      { emit(a: unknown) { actions.push(a as Emitted); }, subscribe: () => () => {} },
      { onEmbeddingModelChanged },
    );
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();
    const startDaemon = vi.spyOn(orchestrator, "startDaemon").mockResolvedValue(true);
    const pullBackend = vi.spyOn(orchestrator, "pullBackend").mockResolvedValue();
    const inner = orchestrator as unknown as Internals;
    built.push(inner);
    const lines = () => actions.map((a) => a.line).filter((l): l is string => !!l);
    return { orchestrator, inner, onEmbeddingModelChanged, startDaemon, pullBackend, lines };
  }

  it("starts only the memory model at launch and attaches memory to it", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubBackendInstalled(dataDir);
    stubChatModelDownloaded(dataDir);
    stubEmbeddingModelDownloaded(dataDir, "bge-m3");
    activate("openrouter");
    const { orchestrator, inner, onEmbeddingModelChanged, startDaemon, lines } = build();

    await orchestrator.autoStartIfReady();

    expect(startDaemon).not.toHaveBeenCalled();
    expect(vi.mocked(localLlm.startEmbeddingDaemon)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(localLlm.startEmbeddingDaemon)).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "bge-m3", dataDir }),
    );
    // Only the memory model's own floor: no chat model runs beside it.
    expect(vi.mocked(localLlm.holdEmbeddingForLowMemory)).toHaveBeenCalledWith(dataDir, { localChatRunning: false });
    expect(getConfig().memory.embeddings.enabled).toBe(true);
    expect(inner.embeddingKeptForCloud).toBe(true);
    expect(onEmbeddingModelChanged).toHaveBeenCalledTimes(1);
    expect(lines()).toContain("local-llm: embedding daemon up (bge-m3, pid 5678) — hybrid recall on");
  });

  it("downloads nothing and stays quiet when the engine is not installed (ATO-357)", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubEmbeddingModelDownloaded(dataDir, "bge-m3");
    activate("openrouter");
    const { orchestrator, onEmbeddingModelChanged, startDaemon, pullBackend, lines } = build();

    await orchestrator.autoStartIfReady();

    expect(pullBackend).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
    expect(vi.mocked(localLlm.startEmbeddingDaemon)).not.toHaveBeenCalled();
    expect(onEmbeddingModelChanged).not.toHaveBeenCalled();
    expect(lines().filter((l) => /engine|embedding/.test(l))).toEqual([]);
  });

  it("starts nothing when the memory model is not downloaded", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubBackendInstalled(dataDir);
    activate("openrouter");
    const { orchestrator, onEmbeddingModelChanged } = build();

    await orchestrator.autoStartIfReady();

    expect(vi.mocked(localLlm.getDaemonStatus)).not.toHaveBeenCalled();
    expect(vi.mocked(localLlm.startEmbeddingDaemon)).not.toHaveBeenCalled();
    expect(onEmbeddingModelChanged).not.toHaveBeenCalled();
  });

  it("starts nothing when embeddings are switched off", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubBackendInstalled(dataDir);
    stubEmbeddingModelDownloaded(dataDir, "bge-m3");
    persistUserLocalModelsConfig({ embeddings: { enabled: false } });
    activate("openrouter");
    const { orchestrator, onEmbeddingModelChanged } = build();

    await orchestrator.autoStartIfReady();

    expect(vi.mocked(localLlm.startEmbeddingDaemon)).not.toHaveBeenCalled();
    expect(onEmbeddingModelChanged).not.toHaveBeenCalled();
  });

  it("leaves a memory model found running as it is and attaches memory to it", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubBackendInstalled(dataDir);
    stubEmbeddingModelDownloaded(dataDir, "bge-m3");
    activate("openrouter");
    embeddingUp = true;
    const { orchestrator, inner, onEmbeddingModelChanged } = build();

    await orchestrator.autoStartIfReady();

    expect(vi.mocked(localLlm.startEmbeddingDaemon)).not.toHaveBeenCalled();
    // Not started by this session: not this session's to stop at exit.
    expect(inner.embeddingKeptForCloud).toBe(false);
    expect(onEmbeddingModelChanged).toHaveBeenCalledTimes(1);
  });

  it("Start on the memory model starts it alone on the cloud route", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubBackendInstalled(dataDir);
    stubEmbeddingModelDownloaded(dataDir, "bge-m3");
    activate("openrouter");
    const { orchestrator, startDaemon, lines } = build();

    await orchestrator.startEmbeddingPairing();

    expect(startDaemon).not.toHaveBeenCalled();
    expect(vi.mocked(localLlm.startEmbeddingDaemon)).toHaveBeenCalledTimes(1);
    expect(lines().some((l) => l.includes("press s to start"))).toBe(false);
  });

  it("Start on the memory model says why when the engine is not installed", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubEmbeddingModelDownloaded(dataDir, "bge-m3");
    activate("openrouter");
    const { orchestrator, pullBackend, lines } = build();

    await orchestrator.startEmbeddingPairing();

    expect(pullBackend).not.toHaveBeenCalled();
    expect(vi.mocked(localLlm.startEmbeddingDaemon)).not.toHaveBeenCalled();
    expect(lines().some((l) => l.includes("the local engine is not installed yet"))).toBe(true);
  });

  it("on the local route with the chat model stopped, Start still asks for the chat model first", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubBackendInstalled(dataDir);
    stubEmbeddingModelDownloaded(dataDir, "bge-m3");
    activate("local-llama");
    const { orchestrator, lines } = build();

    await orchestrator.startEmbeddingPairing();

    expect(vi.mocked(localLlm.startEmbeddingDaemon)).not.toHaveBeenCalled();
    expect(lines()).toContain("local-llm: chat daemon is down — press s to start chat+embedding together");
  });
});

/** A fake llama-server binary, so `isBackendDownloaded` is true. */
function stubBackendInstalled(dataDir: string): void {
  mkdirSync(resolveBackendDir(dataDir), { recursive: true });
  const { binaryName } = resolvePlatformAsset();
  writeFileSync(resolveServerBinPath(dataDir, binaryName), "");
}

function stubChatModelDownloaded(dataDir: string): void {
  const def = localLlm.getLocalModelDef("qwen-3.5-4b");
  mkdirSync(join(dataDir, "models", def.id), { recursive: true });
  writeFileSync(resolveModelFilePath(dataDir, def.id, def.filename), "stub");
}

function stubEmbeddingModelDownloaded(
  dataDir: string,
  id: Parameters<typeof getEmbeddingModelDef>[0],
): void {
  const def = getEmbeddingModelDef(id);
  mkdirSync(join(dataDir, "models", def.id), { recursive: true });
  writeFileSync(resolveModelFilePath(dataDir, def.id, def.filename), "stub");
}
