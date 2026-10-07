import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../local-llm/index.js", async () => {
  const actual = await vi.importActual<typeof import("../local-llm/index.js")>(
    "../local-llm/index.js",
  );
  return {
    ...actual,
    getDaemonStatus: vi.fn(),
    startChatAndEmbeddingDaemons: vi.fn(),
    resolveManagedDevice: vi.fn(),
    listVulkanDevices: vi.fn(),
    probeNvidiaVramMiB: vi.fn(),
    maybeAutoUpdateBackend: vi.fn(),
    // Server lifecycle is scripted here; never reclaim the operator's live port.
    reclaimManagedPort: vi.fn(async () => ({ kind: "free" })),
  };
});

import { getConfig, resetConfigCache } from "../config/index.js";
import * as localLlm from "../local-llm/index.js";
import {
  resolveBackendDir,
  resolveModelFilePath,
  resolveServerBinPath,
} from "../local-llm/index.js";
import { writeBackendVersion } from "../local-llm/backend/backend-version.js";
import { resolvePlatformAsset } from "../local-llm/backend/platform-assets.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import type { LocalTurnGateFacts } from "./local-turn-gate.js";
import { makeTuiEventBus } from "./make-event-bus.js";
import { persistUserLocalModelsConfig } from "./persist-user-local-models-config.js";

const gateFacts = (): LocalTurnGateFacts => ({
  activeProviderIsLocal: true,
  managedMode: true,
  modelId: "qwen-3.5-4b",
  modelDownloaded: true,
  fallbackChainLength: 1,
});

type LocalModelsInternals = {
  restartOwnedDaemon(): Promise<boolean>;
  supervisor: { stop(): void };
};

/**
 * Every managed daemon (re)start must leave the runtime re-reading the
 * new server's `/props` — vision, context window, template — whichever
 * path started it. The operator's `/llm restart` and the supervisor's
 * restart (a death, or a wedge) share `startDaemon`; the refresh hangs
 * off its success, so both paths reach it.
 */
describe("ChatOrchestrator: managed daemon restarts refresh the local model profile", () => {
  let stateDir: string;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "chat-orch-daemon-restart-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    vi.mocked(localLlm.getDaemonStatus)
      .mockReset()
      .mockResolvedValue({ running: false } as never);
    vi.mocked(localLlm.startChatAndEmbeddingDaemons)
      .mockReset()
      .mockResolvedValue({
        chat: { pid: 4242, tokensPerSecond: null },
        embedding: { skipped: true },
      } as never);
    vi.mocked(localLlm.resolveManagedDevice)
      .mockReset()
      .mockResolvedValue(undefined);
    vi.mocked(localLlm.listVulkanDevices).mockReset().mockResolvedValue([]);
    vi.mocked(localLlm.probeNvidiaVramMiB).mockReset().mockResolvedValue(null);
    vi.mocked(localLlm.maybeAutoUpdateBackend)
      .mockReset()
      .mockResolvedValue({ action: "current", tag: null });
    prepareManagedInstall();
  });

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) fn();
    vi.restoreAllMocks();
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function build() {
    const refreshLocalModelProfile = vi.fn(async () => undefined);
    const runtime = {
      sessionStore: {
        listSummaries: () => [],
        countUnreadable: () => 0,
        listRecent: () => [],
        load: () => null,
        delete: () => undefined,
      },
      approvals: {
        clearSessionGrants: () => undefined,
        denyPendingForSession: () => 0,
        pendingRequestForSession: () => null,
      },
      turnController: { isBusy: () => false },
      config: {
        update: { checkOnStartup: false, repo: "x/y" },
        tracing: { trace: { dir: "/tmp", enabled: false } },
      },
      profileStore: { list: () => [] },
      skillCatalog: [],
      refreshLocalModelProfile,
    } as unknown as AgentRuntime;
    const orchestrator = new ChatOrchestrator(runtime, makeTuiEventBus(), {
      maxSteps: 5,
      llamaUrl: "http://127.0.0.1:1",
      readGateFacts: gateFacts,
    });
    const localModels = orchestrator.localModels;
    // The panel repaint and the tray label reach for the disk and the
    // network; neither is what this test is about.
    vi.spyOn(localModels, "refresh").mockResolvedValue();
    const health = (orchestrator as unknown as {
      llmHealth: { refreshModelLabel(): Promise<void> };
    }).llmHealth;
    const label = vi.spyOn(health, "refreshModelLabel").mockResolvedValue();
    const inner = localModels as unknown as LocalModelsInternals;
    cleanups.push(() => inner.supervisor.stop());
    return { localModels, inner, refreshLocalModelProfile, label };
  }

  it("the supervisor's restart (a death or a wedge) re-reads /props", async () => {
    const { inner, refreshLocalModelProfile, label } = build();
    await expect(inner.restartOwnedDaemon()).resolves.toBe(true);
    expect(localLlm.startChatAndEmbeddingDaemons).toHaveBeenCalledTimes(1);
    expect(label).toHaveBeenCalledTimes(1);
    expect(refreshLocalModelProfile).toHaveBeenCalledTimes(1);
  });

  it("does exactly what `/llm restart` does after the new server is up", async () => {
    const byHand = build();
    await expect(byHand.localModels.restartDaemon()).resolves.toBe(true);
    const auto = build();
    await expect(auto.inner.restartOwnedDaemon()).resolves.toBe(true);

    expect(byHand.refreshLocalModelProfile).toHaveBeenCalledTimes(1);
    expect(auto.refreshLocalModelProfile).toHaveBeenCalledTimes(1);
    expect(auto.label.mock.calls.length).toBe(byHand.label.mock.calls.length);
  });

  it("a failed start refreshes nothing", async () => {
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockRejectedValue(
      new Error("llama-server did not become healthy"),
    );
    const { inner, refreshLocalModelProfile } = build();
    await expect(inner.restartOwnedDaemon()).resolves.toBe(false);
    expect(refreshLocalModelProfile).not.toHaveBeenCalled();
  });

  /** Managed mode with a (stub) backend + the chat model on disk. */
  function prepareManagedInstall(): void {
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { modelId: "qwen-3.5-4b" },
    });
    resetConfigCache();
    const dataDir = getConfig().paths.localModelsDataDir;
    mkdirSync(resolveBackendDir(dataDir), { recursive: true });
    const { binaryName } = resolvePlatformAsset();
    writeFileSync(resolveServerBinPath(dataDir, binaryName), "");
    writeBackendVersion(dataDir, {
      tag: "turboquant-test",
      downloadedAt: "2026-06-02T00:00:00.000Z",
      asset: resolvePlatformAsset().assetName ?? "test-asset",
      releasedAt: "2026-06-01T00:00:00Z",
    });
    const def = localLlm.getLocalModelDef("qwen-3.5-4b");
    mkdirSync(join(dataDir, "models", def.id), { recursive: true });
    writeFileSync(resolveModelFilePath(dataDir, def.id, def.filename), "stub");
  }
});
