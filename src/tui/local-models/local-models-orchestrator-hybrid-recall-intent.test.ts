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
    getEmbeddingDaemonStatus: vi.fn(),
    startEmbeddingDaemon: vi.fn(),
    stopEmbeddingDaemon: vi.fn(),
    maybeAutoUpdateBackend: vi.fn(),
  };
});

import { getConfig, resetConfigCache } from "../../config/index.js";
import {
  getUserConfigPath,
  readUserConfigFileSync,
} from "../../config/config-file.js";
import * as localLlm from "../../local-llm/index.js";
import {
  getEmbeddingModelDef,
  resolveBackendDir,
  resolveModelFilePath,
  resolveServerBinPath,
} from "../../local-llm/index.js";
import { resolvePlatformAsset } from "../../local-llm/platform-assets.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { persistEmbeddingHybridRecall } from "../persist-embedding-hybrid-recall.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

const EMBED_MODEL_ID = "bge-m3";
const CHAT_MODEL_ID = "qwen-3.5-4b";

/**
 * Issue #465, second half: `memory.embeddings.enabled` is the operator's
 * durable hybrid-recall opt-in, so only a *user action* or a durable
 * config/disk fact may clear it. `autoStartIfReady` runs once at TUI
 * startup with no user action and reaches both embedding start-failure
 * paths (`startDaemon` -> `reportEmbeddingStartOutcome`, and
 * `ensureEmbeddingPaired`'s own `startEmbeddingDaemon` catch); a daemon
 * that fails to start there must not erase the opt-in on disk.
 */
describe("LocalModelsOrchestrator hybrid-recall intent", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-intent-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    vi.mocked(localLlm.getDaemonStatus).mockReset();
    vi.mocked(localLlm.getEmbeddingDaemonStatus).mockReset();
    vi.mocked(localLlm.startEmbeddingDaemon).mockReset();
    vi.mocked(localLlm.stopEmbeddingDaemon).mockReset();
    vi.mocked(localLlm.maybeAutoUpdateBackend).mockReset();
    vi.mocked(localLlm.maybeAutoUpdateBackend).mockResolvedValue({
      action: "skipped",
    });
  });

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function readFlag(): boolean {
    return readUserConfigFileSync(getUserConfigPath(stateDir)).memory.embeddings
      .enabled;
  }

  /** Operator has opted in: master switch on, model chosen, hybrid recall on. */
  function optIn(): void {
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { modelId: CHAT_MODEL_ID },
      embeddings: { enabled: true, modelId: EMBED_MODEL_ID },
    });
    persistEmbeddingHybridRecall({
      enabled: true,
      modelId: EMBED_MODEL_ID,
    });
    resetConfigCache();
    expect(readFlag()).toBe(true);
  }

  function makeOrchestrator(): LocalModelsOrchestrator {
    const orchestrator = new LocalModelsOrchestrator({
      emit() {},
      subscribe: () => () => {},
    });
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();
    return orchestrator;
  }

  it("keeps the opt-in when the embedding daemon fails to start at TUI launch", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubBackendInstalled(dataDir);
    stubChatModelDownloaded(dataDir);
    stubEmbeddingModelDownloaded(dataDir);
    optIn();
    // Chat daemon left running by a previous session -> the adopt
    // branch of `autoStartIfReady`, which calls `ensureEmbeddingPaired`.
    stubChatStatus(true);
    stubEmbeddingStatus(false);
    vi.mocked(localLlm.startEmbeddingDaemon).mockRejectedValue(
      new Error("spawn llama-server EADDRINUSE"),
    );

    await makeOrchestrator().autoStartIfReady();

    expect(vi.mocked(localLlm.startEmbeddingDaemon)).toHaveBeenCalledTimes(1);
    expect(readFlag()).toBe(true);
    expect(getConfig().memory.embeddings.enabled).toBe(true);
  });

  it("keeps the opt-in when startDaemon reports an embedding start failure", () => {
    stubEmbeddingModelDownloaded(getConfig().paths.localModelsDataDir);
    optIn();

    (
      makeOrchestrator() as unknown as {
        reportEmbeddingStartOutcome: (
          embedding: { error: string },
          requested: { modelId: string } | undefined,
        ) => void;
      }
    ).reportEmbeddingStartOutcome(
      { error: "port 19092 busy" },
      {
        modelId: EMBED_MODEL_ID,
      },
    );

    expect(readFlag()).toBe(true);
    expect(getConfig().memory.embeddings.enabled).toBe(true);
  });

  it("still clears the opt-in when the model is gone — a durable fact, not a sample", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubBackendInstalled(dataDir);
    stubChatModelDownloaded(dataDir);
    optIn(); // note: no embedding GGUF on disk
    stubChatStatus(true);
    stubEmbeddingStatus(false);

    await makeOrchestrator().autoStartIfReady();

    expect(vi.mocked(localLlm.startEmbeddingDaemon)).not.toHaveBeenCalled();
    expect(readFlag()).toBe(false);
  });

  it("clears the opt-in when the operator removes the active embedding model", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubEmbeddingModelDownloaded(dataDir);
    optIn();
    stubEmbeddingStatus(false);

    await makeOrchestrator().removeEmbeddingModel(EMBED_MODEL_ID);

    expect(readFlag()).toBe(false);
    // The master switch is the operator's, and stays as they left it.
    expect(
      readUserConfigFileSync(getUserConfigPath(stateDir)).localModels.embeddings
        .enabled,
    ).toBe(true);
  });

  it("leaves the opt-in alone when a non-active embedding model is removed", async () => {
    const dataDir = getConfig().paths.localModelsDataDir;
    stubEmbeddingModelDownloaded(dataDir);
    optIn();
    stubEmbeddingStatus(false);

    await makeOrchestrator().removeEmbeddingModel("bge-small-en-v1.5");

    expect(readFlag()).toBe(true);
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
  const def = localLlm.getLocalModelDef(CHAT_MODEL_ID);
  mkdirSync(join(dataDir, "models", def.id), { recursive: true });
  writeFileSync(resolveModelFilePath(dataDir, def.id, def.filename), "stub");
}

function stubEmbeddingModelDownloaded(dataDir: string): void {
  const def = getEmbeddingModelDef(EMBED_MODEL_ID);
  mkdirSync(join(dataDir, "models", def.id), { recursive: true });
  writeFileSync(resolveModelFilePath(dataDir, def.id, def.filename), "stub");
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
