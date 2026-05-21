import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../config/config-cache.js";
import { getUserConfigPath, writeUserConfigFileSync } from "../config/config-file.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import { getConfig } from "../config/index.js";
import {
  persistEmbeddingHybridRecall,
  persistMemoryEmbeddingsEnabled,
} from "./persist-embedding-hybrid-recall.js";

describe("persistEmbeddingHybridRecall", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-embed-hybrid-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeUserConfigFileSync(getUserConfigPath(stateDir), USER_CONFIG_DEFAULTS);
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("writes both localModels.embeddings and memory.embeddings.enabled", () => {
    persistEmbeddingHybridRecall({ enabled: true, modelId: "bge-m3" });
    const path = getUserConfigPath(stateDir);
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      localModels: { embeddings: { enabled: boolean; modelId: string } };
      memory: { embeddings: { enabled: boolean } };
    };
    expect(written.localModels.embeddings).toEqual({
      enabled: true,
      modelId: "bge-m3",
      port: 19092,
    });
    expect(written.memory.embeddings.enabled).toBe(true);
    expect(getConfig().memory.embeddings.enabled).toBe(true);
  });

  it("persistMemoryEmbeddingsEnabled toggles only memory.embeddings", () => {
    persistEmbeddingHybridRecall({ enabled: true, modelId: "bge-m3" });
    resetConfigCache();
    persistMemoryEmbeddingsEnabled(false);
    const written = JSON.parse(
      readFileSync(getUserConfigPath(stateDir), "utf8"),
    ) as {
      localModels: { embeddings: { enabled: boolean; modelId: string } };
      memory: { embeddings: { enabled: boolean } };
    };
    expect(written.localModels.embeddings.enabled).toBe(true);
    expect(written.localModels.embeddings.modelId).toBe("bge-m3");
    expect(written.memory.embeddings.enabled).toBe(false);
  });

  it("disables hybrid recall in both places via persistEmbeddingHybridRecall", () => {
    persistEmbeddingHybridRecall({ enabled: true, modelId: "bge-m3" });
    resetConfigCache();
    persistEmbeddingHybridRecall({ enabled: false });
    const written = JSON.parse(
      readFileSync(getUserConfigPath(stateDir), "utf8"),
    ) as {
      localModels: { embeddings: { enabled: boolean } };
      memory: { embeddings: { enabled: boolean } };
    };
    expect(written.localModels.embeddings.enabled).toBe(false);
    expect(written.memory.embeddings.enabled).toBe(false);
  });
});
