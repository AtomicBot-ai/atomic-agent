import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../local-llm/index.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../local-llm/index.js")>(
      "../../local-llm/index.js",
    );
  return {
    ...actual,
    getDaemonStatus: vi.fn(),
    getEmbeddingDaemonStatus: vi.fn(),
    startEmbeddingDaemon: vi.fn(),
    stopEmbeddingDaemon: vi.fn(),
  };
});

import { getConfig, resetConfigCache } from "../../config/index.js";
import * as localLlm from "../../local-llm/index.js";
import {
  getEmbeddingModelDef,
  resolveBackendDir,
  resolveModelFilePath,
  resolveServerBinPath,
} from "../../local-llm/index.js";
import { resolvePlatformAsset } from "../../local-llm/platform-assets.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

type Emitted = { type: string; line?: string };

/**
 * Memory-v2 phase 1B regression tests for the embedding-pairing
 * invariant: when the chat daemon is alive, the embedding daemon must
 * be reconciled to `embeddings.enabled && modelId valid && downloaded`
 * by every code path that mutates embedding-side config outside the
 * main `startDaemon` / `stopDaemon` flows. Locks the user-reported
 * bug ("embedding stopped after start") so it cannot regress.
 */
describe("LocalModelsOrchestrator embedding pairing", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-pair-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    vi.mocked(localLlm.getDaemonStatus).mockReset();
    vi.mocked(localLlm.getEmbeddingDaemonStatus).mockReset();
    vi.mocked(localLlm.startEmbeddingDaemon).mockReset();
    vi.mocked(localLlm.stopEmbeddingDaemon).mockReset();
  });

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("starts the embedding daemon when chat is up and a downloaded model is activated", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubBackendInstalled(dataDir);
    stubEmbeddingModelDownloaded(dataDir, "bge-m3");
    stubChatStatus(true);
    stubEmbeddingStatus(false);
    vi.mocked(localLlm.startEmbeddingDaemon).mockResolvedValue({ pid: 4242 });

    const actions: Emitted[] = [];
    const orchestrator = new LocalModelsOrchestrator({
      emit(a: unknown) {
        actions.push(a as Emitted);
      },
    });
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();

    await orchestrator.setActiveEmbedding("bge-m3");

    expect(vi.mocked(localLlm.startEmbeddingDaemon)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(localLlm.startEmbeddingDaemon)).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "bge-m3", dataDir }),
    );
    expect(actions.map((a) => a.line).filter(Boolean)).toContain(
      "local-llm: embedding daemon up (bge-m3, pid 4242)",
    );
  });

  it("does NOT start the embedding daemon when chat is down — leaves it to the next paired startDaemon", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubBackendInstalled(dataDir);
    stubEmbeddingModelDownloaded(dataDir, "bge-m3");
    stubChatStatus(false);
    stubEmbeddingStatus(false);

    const orchestrator = new LocalModelsOrchestrator({ emit() {} });
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();

    await orchestrator.setActiveEmbedding("bge-m3");

    expect(vi.mocked(localLlm.startEmbeddingDaemon)).not.toHaveBeenCalled();
    expect(vi.mocked(localLlm.stopEmbeddingDaemon)).not.toHaveBeenCalled();
  });

  it("hot-swaps the embedding daemon when a different model is activated and the old daemon is alive", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubBackendInstalled(dataDir);
    stubEmbeddingModelDownloaded(dataDir, "bge-m3");
    stubChatStatus(true);
    stubEmbeddingStatus(true);
    vi.mocked(localLlm.stopEmbeddingDaemon).mockResolvedValue();
    vi.mocked(localLlm.startEmbeddingDaemon).mockResolvedValue({ pid: 9090 });

    const orchestrator = new LocalModelsOrchestrator({ emit() {} });
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();

    await orchestrator.setActiveEmbedding("bge-m3");

    expect(vi.mocked(localLlm.stopEmbeddingDaemon)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(localLlm.startEmbeddingDaemon)).toHaveBeenCalledTimes(1);
  });

  it("stops the embedding daemon when the master switch is flipped off while it is running", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubBackendInstalled(dataDir);
    stubEmbeddingModelDownloaded(dataDir, "bge-m3");
    persistUserLocalModelsConfig({
      embeddings: { enabled: true, modelId: "bge-m3" },
    });
    resetConfigCache();
    stubChatStatus(true);
    stubEmbeddingStatus(true);
    vi.mocked(localLlm.stopEmbeddingDaemon).mockResolvedValue();

    const orchestrator = new LocalModelsOrchestrator({ emit() {} });
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();

    await orchestrator.toggleEmbeddingEnabled();

    expect(vi.mocked(localLlm.stopEmbeddingDaemon)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(localLlm.startEmbeddingDaemon)).not.toHaveBeenCalled();
  });

  it("autoStartIfReady adopts a running chat and pairs the embedding daemon", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubBackendInstalled(dataDir);
    stubChatModelDownloaded(dataDir);
    stubEmbeddingModelDownloaded(dataDir, "bge-m3");
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { modelId: "qwen-3.5-4b" },
      embeddings: { enabled: true, modelId: "bge-m3" },
    });
    resetConfigCache();
    stubChatStatus(true);
    stubEmbeddingStatus(false);
    vi.mocked(localLlm.startEmbeddingDaemon).mockResolvedValue({ pid: 11195 });

    const orchestrator = new LocalModelsOrchestrator({ emit() {} });
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();

    await orchestrator.autoStartIfReady();

    expect(vi.mocked(localLlm.startEmbeddingDaemon)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(localLlm.startEmbeddingDaemon)).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "bge-m3" }),
    );
  });
});

/** Materialise a fake llama-server binary so `isBackendDownloaded` returns true. */
function stubBackendInstalled(dataDir: string): void {
  const backendDir = resolveBackendDir(dataDir);
  mkdirSync(backendDir, { recursive: true });
  const { binaryName } = resolvePlatformAsset();
  writeFileSync(resolveServerBinPath(dataDir, binaryName), "");
}

function stubChatModelDownloaded(dataDir: string): void {
  const def = localLlm.getLocalModelDef("qwen-3.5-4b");
  const modelDir = join(dataDir, "models", def.id);
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(resolveModelFilePath(dataDir, def.id, def.filename), "stub");
}

function stubEmbeddingModelDownloaded(
  dataDir: string,
  id: Parameters<typeof getEmbeddingModelDef>[0],
): void {
  const def = getEmbeddingModelDef(id);
  const path = resolveModelFilePath(dataDir, def.id, def.filename);
  mkdirSync(join(dataDir, "models", def.id), { recursive: true });
  writeFileSync(path, "stub");
}

function stubChatStatus(running: boolean): void {
  vi.mocked(localLlm.getDaemonStatus).mockResolvedValue({
    running,
    healthy: running,
    loading: false,
    pid: running ? 1234 : null,
    port: 19091,
  });
}

function stubEmbeddingStatus(running: boolean): void {
  vi.mocked(localLlm.getEmbeddingDaemonStatus).mockResolvedValue({
    running,
    healthy: running,
    loading: false,
    pid: running ? 5678 : null,
    port: 19092,
  });
}
