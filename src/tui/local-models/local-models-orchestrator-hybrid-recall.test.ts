import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getConfig,
  resetConfigCache,
  USER_CONFIG_VERSION,
} from "../../config/index.js";
import {
  getEmbeddingModelDef,
  resolveModelFilePath,
} from "../../local-llm/index.js";
import type { EmbeddingDaemonInfo } from "./local-models-panel-state.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

const EMBED_MODEL_ID = "bge-small-en-v1.5";

/**
 * The reconciler runs off the snapshot timer with no user action, so
 * `emb.running` is a transient observation — it must never be allowed to
 * write the operator's hybrid-recall opt-in back to `false` on disk.
 */
describe("LocalModelsOrchestrator hybrid-recall reconciler", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-hybrid-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function writeUserConfig(memoryEmbeddingsEnabled: boolean): void {
    writeFileSync(
      join(stateDir, "config.json"),
      JSON.stringify({
        version: USER_CONFIG_VERSION,
        localModels: {
          embeddings: { enabled: true, modelId: EMBED_MODEL_ID },
        },
        memory: { embeddings: { enabled: memoryEmbeddingsEnabled } },
      }),
    );
    resetConfigCache();
  }

  /** Materialise the embedding GGUF so `isEmbeddingModelDownloaded` passes. */
  function stubEmbeddingModelDownloaded(): void {
    const def = getEmbeddingModelDef(EMBED_MODEL_ID);
    const path = resolveModelFilePath(
      getConfig().paths.localModelsDataDir,
      def.id,
      def.filename,
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }

  function reconcile(running: boolean): void {
    const orchestrator = new LocalModelsOrchestrator({
      emit() {},
      subscribe: () => () => {},
    });
    const emb: EmbeddingDaemonInfo = {
      enabled: true,
      running,
      healthy: running,
      loading: false,
      pid: running ? 4242 : null,
      port: getConfig().localModels.embeddings.port,
      activeModelId: EMBED_MODEL_ID,
    };
    (
      orchestrator as unknown as {
        reconcileHybridRecallFromDaemon: (e: EmbeddingDaemonInfo) => void;
      }
    ).reconcileHybridRecallFromDaemon(emb);
  }

  function readMemoryEmbeddingsEnabled(): boolean {
    const raw = JSON.parse(
      readFileSync(join(stateDir, "config.json"), "utf8"),
    ) as { memory?: { embeddings?: { enabled?: boolean } } };
    return raw.memory?.embeddings?.enabled === true;
  }

  it("never persists false when the daemon is momentarily not running", () => {
    writeUserConfig(true);
    stubEmbeddingModelDownloaded();
    reconcile(false);
    expect(readMemoryEmbeddingsEnabled()).toBe(true);
    expect(getConfig().memory.embeddings.enabled).toBe(true);
  });

  it("still latches hybrid recall on once the daemon is up", () => {
    writeUserConfig(false);
    stubEmbeddingModelDownloaded();
    reconcile(true);
    expect(readMemoryEmbeddingsEnabled()).toBe(true);
    expect(getConfig().memory.embeddings.enabled).toBe(true);
  });

  it("does not latch on while the embedding model is not downloaded", () => {
    writeUserConfig(false);
    reconcile(true);
    expect(readMemoryEmbeddingsEnabled()).toBe(false);
  });
});
