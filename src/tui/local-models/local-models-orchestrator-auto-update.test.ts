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
    maybeAutoUpdateBackend: vi.fn(),
  };
});

import { getConfig, resetConfigCache } from "../../config/index.js";
import * as localLlm from "../../local-llm/index.js";
import {
  resolveBackendDir,
  resolveModelFilePath,
  resolveServerBinPath,
} from "../../local-llm/index.js";
import { resolvePlatformAsset } from "../../local-llm/platform-assets.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

type Emitted = { type: string; line?: string };

/**
 * The backend auto-update runs on every managed start, and it stops the
 * daemon before downloading. If a post-check failure aborted the start,
 * the user would be left with nothing running — strictly worse than not
 * having the feature. These tests pin that a failed update still lets
 * the existing binary start, and that the one genuinely fatal case
 * (nothing usable left on disk) still stops.
 */
describe("LocalModelsOrchestrator backend auto-update", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-au-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    vi.mocked(localLlm.getDaemonStatus).mockReset();
    vi.mocked(localLlm.getEmbeddingDaemonStatus).mockReset();
    vi.mocked(localLlm.startEmbeddingDaemon).mockReset();
    vi.mocked(localLlm.stopEmbeddingDaemon).mockReset();
    vi.mocked(localLlm.maybeAutoUpdateBackend).mockReset();
  });

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("starts the existing binary when the update failed but a backend remains", async () => {
    const dataDir = prepareManagedInstall();
    vi.mocked(localLlm.maybeAutoUpdateBackend).mockResolvedValue({
      action: "update_failed",
      error: "socket hang up",
      backendUsable: true,
    });

    const actions: Emitted[] = [];
    const orchestrator = new LocalModelsOrchestrator({
      emit(a: unknown) {
        actions.push(a as Emitted);
      },
    });
    vi.spyOn(orchestrator, "startDaemon").mockResolvedValue(true);
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();
    // No daemon adopted, so autoStartIfReady must reach startDaemon.
    vi.mocked(localLlm.getDaemonStatus).mockResolvedValue({
      running: false,
      healthy: false,
      loading: false,
      pid: null,
      port: 19091,
    });

    await orchestrator.autoStartIfReady();

    expect(orchestrator.startDaemon).toHaveBeenCalledTimes(1);
    expect(actions.map((a) => a.line).filter(Boolean)).toContain(
      "local-llm: backend update failed — starting current binary (socket hang up)",
    );
  });

  it("does not start when the update failed and no usable backend remains", async () => {
    prepareManagedInstall();
    vi.mocked(localLlm.maybeAutoUpdateBackend).mockResolvedValue({
      action: "update_failed",
      error: "disk full",
      backendUsable: false,
    });

    const actions: Emitted[] = [];
    const orchestrator = new LocalModelsOrchestrator({
      emit(a: unknown) {
        actions.push(a as Emitted);
      },
    });
    vi.spyOn(orchestrator, "startDaemon").mockResolvedValue(true);
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();

    await orchestrator.autoStartIfReady();

    expect(orchestrator.startDaemon).not.toHaveBeenCalled();
    expect(actions.map((a) => a.line).filter(Boolean)).toContain(
      "local-llm: backend update failed and no usable backend remains — disk full",
    );
  });

  /** Managed mode with backend + chat model already on disk. */
  function prepareManagedInstall(): string {
    const dataDir = getConfig().paths.localModelsDataDir;
    const backendDir = resolveBackendDir(dataDir);
    mkdirSync(backendDir, { recursive: true });
    const { binaryName } = resolvePlatformAsset();
    writeFileSync(resolveServerBinPath(dataDir, binaryName), "");
    const def = localLlm.getLocalModelDef("qwen-3.5-4b");
    mkdirSync(join(dataDir, "models", def.id), { recursive: true });
    writeFileSync(resolveModelFilePath(dataDir, def.id, def.filename), "stub");
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { modelId: "qwen-3.5-4b" },
    });
    resetConfigCache();
    return dataDir;
  }
});
