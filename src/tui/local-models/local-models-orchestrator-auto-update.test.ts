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

  // `autoStartIfReady` runs the update check itself and then delegates to
  // `startDaemon`, which runs the same check — a TUI launch used to hit
  // GitHub twice (against a ~60 req/h anonymous budget) and start two
  // passes racing on the same `backend.next` staging dir. The flag below
  // is what keeps it to one; these tests fail if it stops being passed.
  it("checks for a backend update exactly once per start", async () => {
    prepareManagedInstall();
    vi.mocked(localLlm.maybeAutoUpdateBackend).mockResolvedValue({
      action: "current",
      tag: "turboquant-07b9908",
    });

    const orchestrator = new LocalModelsOrchestrator({ emit() {} });
    const startDaemon = vi
      .spyOn(orchestrator, "startDaemon")
      .mockResolvedValue(true);
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();
    vi.mocked(localLlm.getDaemonStatus).mockResolvedValue({
      running: false,
      healthy: false,
      loading: false,
      pid: null,
      port: 19091,
    });

    await orchestrator.autoStartIfReady();

    expect(localLlm.maybeAutoUpdateBackend).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledWith({ backendAlreadyChecked: true });
  });

  // The flag must be opt-in: a bare `startDaemon()` (the `s` key, or a
  // restart after a model switch) is the only update check on that path,
  // so defaulting it to "already checked" would silently disable
  // auto-update everywhere except TUI launch.
  // Complements the flag test above: that one mocks `startDaemon`, so it
  // only proves the flag is PASSED. This one calls the real method with
  // the flag set and proves it is HONOURED — without it, the guard clause
  // could be deleted and the pair would still look green.
  it("skips the check when startDaemon is told the backend was checked", async () => {
    prepareManagedInstall();
    vi.mocked(localLlm.maybeAutoUpdateBackend).mockResolvedValue({
      action: "update_failed",
      error: "disk full",
      backendUsable: false,
    });

    const orchestrator = new LocalModelsOrchestrator({ emit() {} });
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();

    // With the check skipped there is nothing to bail on, so the start
    // proceeds past the point where `backendUsable: false` would stop it.
    await orchestrator.startDaemon({ backendAlreadyChecked: true });

    expect(localLlm.maybeAutoUpdateBackend).not.toHaveBeenCalled();
  });

  it("still checks when startDaemon is invoked without the flag", async () => {
    prepareManagedInstall();
    vi.mocked(localLlm.maybeAutoUpdateBackend).mockResolvedValue({
      action: "update_failed",
      error: "disk full",
      backendUsable: false,
    });

    const orchestrator = new LocalModelsOrchestrator({ emit() {} });
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();

    // `backendUsable: false` makes startDaemon bail before spawning, so
    // this exercises the check without launching a real llama-server.
    await expect(orchestrator.startDaemon()).resolves.toBe(false);

    expect(localLlm.maybeAutoUpdateBackend).toHaveBeenCalledTimes(1);
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
