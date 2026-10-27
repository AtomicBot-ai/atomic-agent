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
    fetchServedModelIds: vi.fn(async () => null),
    getEmbeddingDaemonStatus: vi.fn(),
    startEmbeddingDaemon: vi.fn(),
    stopEmbeddingDaemon: vi.fn(),
    maybeAutoUpdateBackend: vi.fn(),
    resolveManagedDevice: vi.fn(async () => undefined),
    listVulkanDevices: vi.fn(async () => []),
    probeNvidiaVramMiB: vi.fn(async () => null),
    startChatAndEmbeddingDaemons: vi.fn<typeof actual.startChatAndEmbeddingDaemons>(),
  };
});

import { getConfig, resetConfigCache } from "../../config/index.js";
import * as localLlm from "../../local-llm/index.js";
import {
  resolveBackendDir,
  resolveModelFilePath,
  resolveServerBinPath,
} from "../../local-llm/index.js";
import { resolvePlatformAsset } from "../../local-llm/backend/platform-assets.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

interface GrowthInternals {
  grownContext: { modelId: string; atLeast: number } | null;
  growthAttempt: number | null;
}

/**
 * The window a growth restart asks for reaches `startDaemon` only through
 * the chat options this orchestrator builds; these tests pin that hand-off
 * on the plain local chat route (the default route), which is the one
 * launch that opts in to the growing window.
 */
describe("LocalModelsOrchestrator: the grown local window (ATO-848)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-grow-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    vi.mocked(localLlm.maybeAutoUpdateBackend).mockReset();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockReset();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockResolvedValue({
      chat: {
        pid: 4343,
        tokensPerSecond: null,
        contextSize: 32_768,
        swaFull: { enabled: false, reason: "unit test", estimate: null, slidingLayers: 0 },
        prefixReuse: null,
      },
      embedding: { skipped: true },
    });
  });

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function prepareManagedInstall(): void {
    const dataDir = getConfig().paths.localModelsDataDir;
    mkdirSync(resolveBackendDir(dataDir), { recursive: true });
    const { binaryName } = resolvePlatformAsset();
    writeFileSync(resolveServerBinPath(dataDir, binaryName), "");
    const def = localLlm.getLocalModelDef("qwen-3.5-4b");
    mkdirSync(join(dataDir, "models", def.id), { recursive: true });
    writeFileSync(resolveModelFilePath(dataDir, def.id, def.filename), "stub");
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { engine: "llama-server", modelId: "qwen-3.5-4b" },
    });
    resetConfigCache();
  }

  async function startWith(state: Partial<GrowthInternals>) {
    prepareManagedInstall();
    const orchestrator = new LocalModelsOrchestrator({ emit() {}, subscribe: () => () => {} });
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();
    Object.assign(orchestrator as unknown as GrowthInternals, state);
    await expect(orchestrator.startDaemon({ backendAlreadyChecked: true })).resolves.toBe(true);
    const call = vi.mocked(localLlm.startChatAndEmbeddingDaemons).mock.calls[0]![0];
    return call.chat;
  }

  it("opts the local chat route in, and starts small when nothing was grown", async () => {
    const chat = await startWith({});
    expect(chat.growContext).toBe(true);
    expect(chat.autoContextAtLeast).toBeUndefined();
  });

  it("starts at the window this model was grown to", async () => {
    const chat = await startWith({ grownContext: { modelId: "qwen-3.5-4b", atLeast: 65_536 } });
    expect(chat.autoContextAtLeast).toBe(65_536);
  });

  it("asks for the window a growth restart is trying, over the one that stands", async () => {
    const chat = await startWith({
      grownContext: { modelId: "qwen-3.5-4b", atLeast: 65_536 },
      growthAttempt: 131_072,
    });
    expect(chat.autoContextAtLeast).toBe(131_072);
  });

  it("starts another model small again", async () => {
    const chat = await startWith({ grownContext: { modelId: "gemma-4-12b", atLeast: 65_536 } });
    expect(chat.autoContextAtLeast).toBeUndefined();
  });
});
