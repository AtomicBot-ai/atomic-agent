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
    startChatAndEmbeddingDaemons: vi.fn(),
    fallBackToCpuBackend: vi.fn(),
    resolveManagedDevice: vi.fn(),
    listVulkanDevices: vi.fn(),
    probeNvidiaVramMiB: vi.fn(),
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
import { writeBackendVersion } from "../../local-llm/backend-version.js";
import { DaemonHealthError } from "../../local-llm/daemon-lifecycle.js";
import { resolvePlatformAsset } from "../../local-llm/platform-assets.js";
import {
  WINDOWS_BACKEND_ASSETS,
  setConfiguredBackendVariant,
} from "../../local-llm/windows-backend-variant.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

type Emitted = {
  type: string;
  line?: string;
  message?: string;
  kind?: string;
  percent?: number;
};

const healthError = () =>
  new DaemonHealthError(
    "llama-server did not become healthy within 30000ms. Log tail:\n(no log)",
  );

/**
 * Integration tests for the Windows CPU-backend fallback WIRING in
 * `startDaemon` — the pure pieces (`shouldFallBackToCpuBackend`,
 * `fallBackToCpuBackend`) are covered in `cpu-backend-fallback.test.ts`,
 * but only these tests prove the orchestrator actually consults them:
 * that an eligible health failure swaps the backend and retries exactly
 * once, that the retry cannot recurse, and that the download runs with
 * a deadline and live progress (a stalled-open connection must not pin
 * the start on "starting" for the life of the process).
 */
describe("LocalModelsOrchestrator CPU-backend fallback", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-cpufb-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    // The fallback is Windows-only; the real eligibility gate must see
    // win32 or these tests would silently assert nothing.
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    resetConfigCache();
    setConfiguredBackendVariant("auto");
    vi.mocked(localLlm.getDaemonStatus).mockReset();
    vi.mocked(localLlm.getEmbeddingDaemonStatus).mockReset();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockReset();
    vi.mocked(localLlm.fallBackToCpuBackend)
      .mockReset()
      .mockResolvedValue({ tag: "turboquant-x" });
    vi.mocked(localLlm.resolveManagedDevice).mockReset().mockResolvedValue(undefined);
    vi.mocked(localLlm.listVulkanDevices).mockReset().mockResolvedValue([]);
    vi.mocked(localLlm.probeNvidiaVramMiB).mockReset().mockResolvedValue(null);
    vi.mocked(localLlm.maybeAutoUpdateBackend).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setConfiguredBackendVariant("auto");
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("swaps in the CPU build, persists the variant and retries once", async () => {
    const dataDir = prepareManagedWindowsInstall();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons)
      .mockRejectedValueOnce(healthError())
      .mockResolvedValueOnce({ chat: { pid: 4242 }, embedding: { skipped: true } });

    const { orchestrator, actions } = makeOrchestrator();

    await expect(orchestrator.startDaemon({ backendAlreadyChecked: true })).resolves.toBe(
      true,
    );

    expect(localLlm.fallBackToCpuBackend).toHaveBeenCalledTimes(1);
    expect(localLlm.startChatAndEmbeddingDaemons).toHaveBeenCalledTimes(2);
    // The loop-guard against auto-update reinstalling the broken GPU
    // build: the preference must land in the user config, not just in
    // process memory.
    expect(getConfig().localModels.managed.backendVariant).toBe("cpu");
    const lines = actions.map((a) => a.line).filter(Boolean);
    expect(lines.some((l) => l!.includes("falling back to the CPU build"))).toBe(true);
    expect(lines.some((l) => l!.includes('recorded backendVariant "cpu"'))).toBe(true);
    // Download surfaced as a regular backend pull so the panel shows it.
    expect(actions.some((a) => a.type === "local_models_pull_started")).toBe(true);
    expect(actions.some((a) => a.type === "local_models_pull_finished")).toBe(true);

    // The download must carry a deadline and live progress — without
    // them a stalled-open connection pins the start forever with zero
    // feedback (the exact hazard the auto-update path guards against).
    const [calledDataDir, dlOpts] = vi.mocked(localLlm.fallBackToCpuBackend).mock
      .calls[0]! as [string, { signal?: AbortSignal; onProgress?: (p: number, t: number, tot: number) => void }];
    expect(calledDataDir).toBe(dataDir);
    expect(dlOpts.signal).toBeInstanceOf(AbortSignal);
    expect(dlOpts.onProgress).toBeTypeOf("function");
    dlOpts.onProgress!(50, 15_000_000, 30_000_000);
    expect(
      actions.some((a) => a.type === "local_models_pull_progress" && a.percent === 50),
    ).toBe(true);
  });

  it("falls back at most once — a CPU build that also fails to serve stops", async () => {
    prepareManagedWindowsInstall();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockRejectedValue(healthError());

    const { orchestrator, actions } = makeOrchestrator();

    await expect(orchestrator.startDaemon({ backendAlreadyChecked: true })).resolves.toBe(
      false,
    );

    expect(localLlm.fallBackToCpuBackend).toHaveBeenCalledTimes(1);
    expect(localLlm.startChatAndEmbeddingDaemons).toHaveBeenCalledTimes(2);
    expect(actions.some((a) => a.type === "local_models_daemon_error_set")).toBe(true);
  });

  it("reports the failure and gives up when the CPU download itself fails", async () => {
    prepareManagedWindowsInstall();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockRejectedValue(healthError());
    vi.mocked(localLlm.fallBackToCpuBackend).mockRejectedValue(new Error("HTTP 503"));

    const { orchestrator, actions } = makeOrchestrator();

    await expect(orchestrator.startDaemon({ backendAlreadyChecked: true })).resolves.toBe(
      false,
    );

    expect(localLlm.startChatAndEmbeddingDaemons).toHaveBeenCalledTimes(1);
    expect(actions.some((a) => a.type === "local_models_pull_failed")).toBe(true);
    const err = actions.find((a) => a.type === "local_models_daemon_error_set");
    expect(err?.message).toContain("CPU backend fallback failed — HTTP 503");
    expect(err?.message).toContain("original start failure");
  });

  it("leaves a non-health start failure alone", async () => {
    prepareManagedWindowsInstall();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockRejectedValue(
      new Error("port 19091 already in use"),
    );

    const { orchestrator, actions } = makeOrchestrator();

    await expect(orchestrator.startDaemon({ backendAlreadyChecked: true })).resolves.toBe(
      false,
    );

    expect(localLlm.fallBackToCpuBackend).not.toHaveBeenCalled();
    expect(getConfig().localModels.managed.backendVariant).toBe("auto");
    const err = actions.find((a) => a.type === "local_models_daemon_error_set");
    expect(err?.message).toContain("port 19091 already in use");
  });

  it("never falls back when the CPU build is already installed", async () => {
    prepareManagedWindowsInstall(WINDOWS_BACKEND_ASSETS.cpu);
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockRejectedValue(healthError());

    const { orchestrator } = makeOrchestrator();

    await expect(orchestrator.startDaemon({ backendAlreadyChecked: true })).resolves.toBe(
      false,
    );

    expect(localLlm.fallBackToCpuBackend).not.toHaveBeenCalled();
  });

  function makeOrchestrator(): {
    orchestrator: LocalModelsOrchestrator;
    actions: Emitted[];
  } {
    const actions: Emitted[] = [];
    const orchestrator = new LocalModelsOrchestrator({
      emit(a: unknown) {
        actions.push(a as Emitted);
      },
      subscribe: () => () => {},
    });
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();
    return { orchestrator, actions };
  }

  /**
   * Managed mode with a (stub) Windows GPU install + chat model on
   * disk, so the real `shouldFallBackToCpuBackend` sees an eligible
   * machine: win32, variant `auto`, a GPU asset recorded.
   */
  function prepareManagedWindowsInstall(
    asset: string = WINDOWS_BACKEND_ASSETS.vulkan,
  ): string {
    const dataDir = getConfig().paths.localModelsDataDir;
    const backendDir = resolveBackendDir(dataDir);
    mkdirSync(backendDir, { recursive: true });
    const { binaryName } = resolvePlatformAsset();
    writeFileSync(resolveServerBinPath(dataDir, binaryName), "");
    writeBackendVersion(dataDir, {
      tag: "turboquant-win",
      downloadedAt: "2026-06-02T00:00:00.000Z",
      asset,
      releasedAt: "2026-06-01T00:00:00Z",
    });
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
