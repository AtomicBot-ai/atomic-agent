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
    // Never the real one: it would stop or move whatever holds this machine's port.
    reclaimManagedPort: vi.fn(async () => ({ kind: "free" })),
    getEmbeddingDaemonStatus: vi.fn(),
    startChatAndEmbeddingDaemons: vi.fn(),
    fallBackToCpuBackend: vi.fn(),
    fallBackToCoreCpuBuild: vi.fn(),
    revertCoreCpuFallback: vi.fn(),
    // The decision itself is covered in core-cpu-backend-fallback.test.ts.
    coreCpuFallbackApplies: vi.fn(),
    // A Core install stands in: the engine is not what is under test.
    isBackendDownloaded: vi.fn(() => true),
    resolveServerBinPath: vi.fn(() => "/core/llama-server.exe"),
    managedDeviceSource: vi.fn(() => null),
    resolveManagedDevice: vi.fn(),
    listVulkanDevices: vi.fn(),
    probeNvidiaVramMiB: vi.fn(),
    maybeAutoUpdateBackend: vi.fn(),
  };
});

import { getConfig, resetConfigCache } from "../../config/index.js";
import * as localLlm from "../../local-llm/index.js";
import { resolveModelFilePath } from "../../local-llm/index.js";
import { CoreRequestError } from "../../local-llm/core/core-client.js";
import { setConfiguredBackendVariant, setConfiguredCoreBackendVariant } from "../../local-llm/backend/windows-backend-variant.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

type Emitted = { type: string; line?: string; message?: string };

const SWAP = { tag: "Atomic Core x · b2", previous: null, previousVariant: "auto" as const };

const crash = () => new CoreRequestError(500, "Could not load model qwen-3.5-4b after fallback attempts.", "MODEL_LOAD_FAILED");

/**
 * The Atomic Core CPU-build rescue WIRING in the TUI start (ATO-344/372):
 * an eligible load crash installs Core's CPU build and retries exactly
 * once on device cpu; `coreBackendVariant: "cpu"` is recorded only when
 * that retry serves the model, a failed retry is undone, and anything
 * else is reported as before.
 */
describe("LocalModelsOrchestrator Atomic Core CPU-build fallback", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-core-cpufb-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    resetConfigCache();
    setConfiguredBackendVariant("auto");
    vi.mocked(localLlm.getDaemonStatus).mockReset();
    vi.mocked(localLlm.getEmbeddingDaemonStatus).mockReset();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockReset();
    vi.mocked(localLlm.fallBackToCpuBackend).mockReset();
    vi.mocked(localLlm.fallBackToCoreCpuBuild).mockReset().mockResolvedValue(SWAP);
    vi.mocked(localLlm.revertCoreCpuFallback).mockReset();
    vi.mocked(localLlm.coreCpuFallbackApplies).mockReset().mockReturnValue(true);
    vi.mocked(localLlm.resolveManagedDevice).mockReset().mockResolvedValue(undefined);
    vi.mocked(localLlm.listVulkanDevices).mockReset().mockResolvedValue([]);
    vi.mocked(localLlm.probeNvidiaVramMiB).mockReset().mockResolvedValue(null);
    vi.mocked(localLlm.maybeAutoUpdateBackend).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setConfiguredBackendVariant("auto");
    setConfiguredCoreBackendVariant("auto");
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("installs Core's CPU build, records cpu and retries once on device cpu", async () => {
    prepareCoreInstall();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons)
      .mockRejectedValueOnce(crash())
      .mockResolvedValueOnce({ chat: { pid: 4242 }, embedding: { skipped: true } } as never);
    const { orchestrator, actions } = makeOrchestrator();

    await expect(orchestrator.startDaemon({ backendAlreadyChecked: true })).resolves.toBe(true);

    expect(localLlm.fallBackToCoreCpuBuild).toHaveBeenCalledTimes(1);
    expect(localLlm.fallBackToCpuBackend).not.toHaveBeenCalled();
    const starts = vi.mocked(localLlm.startChatAndEmbeddingDaemons).mock.calls;
    expect(starts).toHaveLength(2);
    expect(starts[1]![0].chat.device).toBe("cpu");
    // Recorded after the CPU build served the model, in Core's own key.
    expect(getConfig().localModels.managed.coreBackendVariant).toBe("cpu");
    expect(getConfig().localModels.managed.backendVariant).toBe("auto");
    expect(localLlm.revertCoreCpuFallback).not.toHaveBeenCalled();
    const lines = actions.map(a => a.line).filter(Boolean);
    expect(lines.some(l => l!.includes("falling back to the CPU build (slower)"))).toBe(true);
    expect(lines.some(l => l!.includes('coreBackendVariant "cpu"') && l!.includes("atomic-agent models update"))).toBe(true);
    const [, dlOpts] = vi.mocked(localLlm.fallBackToCoreCpuBuild).mock.calls[0]! as [string, { signal?: AbortSignal }];
    expect(dlOpts.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back at most once, and undoes the swap when the CPU build fails too", async () => {
    prepareCoreInstall();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockRejectedValue(crash());
    const { orchestrator, actions } = makeOrchestrator();

    await expect(orchestrator.startDaemon({ backendAlreadyChecked: true })).resolves.toBe(false);

    expect(localLlm.fallBackToCoreCpuBuild).toHaveBeenCalledTimes(1);
    expect(localLlm.startChatAndEmbeddingDaemons).toHaveBeenCalledTimes(2);
    expect(localLlm.revertCoreCpuFallback).toHaveBeenCalledTimes(1);
    expect(vi.mocked(localLlm.revertCoreCpuFallback).mock.calls[0]![1]).toBe(SWAP);
    expect(getConfig().localModels.managed.coreBackendVariant).toBe("auto");
    // The original failure is the one shown.
    const last = actions.filter(a => a.type === "local_models_daemon_error_set").at(-1);
    expect(last?.message).toContain("Could not load model qwen-3.5-4b");
    expect(last?.message).toContain("the CPU build failed too");
  });

  it("undoes the swap when the CPU retry is cancelled by another model pick", async () => {
    prepareCoreInstall();
    const { orchestrator } = makeOrchestrator();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons)
      .mockRejectedValueOnce(crash())
      .mockImplementationOnce(async () => {
        // What a newer model pick does to the running start: the queue
        // aborts it (a pick from inside this mock would run nested).
        (orchestrator as unknown as { operations: { latest: AbortController | null } }).operations.latest?.abort();
        throw crash();
      });

    await expect(orchestrator.startDaemon({ backendAlreadyChecked: true })).resolves.toBe(false);

    expect(localLlm.revertCoreCpuFallback).toHaveBeenCalledTimes(1);
    expect(vi.mocked(localLlm.revertCoreCpuFallback).mock.calls[0]![1]).toBe(SWAP);
    expect(getConfig().localModels.managed.coreBackendVariant).toBe("auto");
  });

  it("records nothing when the CPU build cannot be installed, so the next start rescues again", async () => {
    prepareCoreInstall();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockRejectedValue(crash());
    vi.mocked(localLlm.fallBackToCoreCpuBuild).mockRejectedValue(new Error("fetch failed"));
    const { orchestrator, actions } = makeOrchestrator();

    await expect(orchestrator.startDaemon({ backendAlreadyChecked: true })).resolves.toBe(false);
    expect(getConfig().localModels.managed.coreBackendVariant).toBe("auto");
    expect(localLlm.startChatAndEmbeddingDaemons).toHaveBeenCalledTimes(1);
    const err = actions.filter(a => a.type === "local_models_daemon_error_set").at(-1);
    expect(err?.message).toContain("Could not load model qwen-3.5-4b");
    expect(err?.message).toContain("fetch failed");

    await expect(orchestrator.startDaemon({ backendAlreadyChecked: true })).resolves.toBe(false);
    expect(localLlm.fallBackToCoreCpuBuild).toHaveBeenCalledTimes(2);
  });

  it("leaves a failure that is not a build crash alone", async () => {
    prepareCoreInstall();
    vi.mocked(localLlm.coreCpuFallbackApplies).mockReturnValue(false);
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockRejectedValue(new CoreRequestError(500, "out of memory"));
    const { orchestrator } = makeOrchestrator();

    await expect(orchestrator.startDaemon({ backendAlreadyChecked: true })).resolves.toBe(false);

    expect(localLlm.fallBackToCoreCpuBuild).not.toHaveBeenCalled();
    expect(localLlm.startChatAndEmbeddingDaemons).toHaveBeenCalledTimes(1);
    expect(getConfig().localModels.managed.coreBackendVariant).toBe("auto");
  });

  function makeOrchestrator(): { orchestrator: LocalModelsOrchestrator; actions: Emitted[] } {
    const actions: Emitted[] = [];
    const orchestrator = new LocalModelsOrchestrator({
      emit(a: unknown) { actions.push(a as Emitted); },
      subscribe: () => () => {},
    });
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();
    return { orchestrator, actions };
  }

  /** Managed mode on the Atomic Core engine with a chat model on disk. */
  function prepareCoreInstall(): void {
    const dataDir = getConfig().paths.localModelsDataDir;
    const def = localLlm.getLocalModelDef("qwen-3.5-4b");
    mkdirSync(join(dataDir, "models", def.id), { recursive: true });
    writeFileSync(resolveModelFilePath(dataDir, def.id, def.filename), "stub");
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { engine: "atomic-core", modelId: "qwen-3.5-4b" },
    });
    resetConfigCache();
  }
});
